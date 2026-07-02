// B-12 · SSE 插件（脊柱 §5）。永不裸转圈的核心机制（Codex#3）。
//   真实 text/event-stream 流：握手 + 连接即 state_snapshot + 心跳 + Last-Event-ID 恢复协议。
//   - 帧格式：id:（= Redis Stream entry id，Last-Event-ID 用）/ event: / data:（脊柱 §5.3）。
//   - 连接首帧（脊柱 §5.2 / §5.4）：
//       · Last-Event-ID 仍在窗口内 → 从该 id 之后补发增量（不重推 snapshot）；
//       · 超窗 / 无 Last-Event-ID → 先推 state_snapshot（按 kind 三型）重置，再续流。
//   - 心跳默认 15s（SSE_HEARTBEAT_INTERVAL_MS，脊柱 §5.5）：发【具名 heartbeat 帧】+ data:{ts}（Codex#5），
//     不是不可观测的 SSE comment（: hb）——前端 EventSource 收得到具名事件、watchdog 据此复位，空业务流不再反复重连。
//   - 鉴权统一同源 Cookie、建流前 HTTP 失败（脊柱 §11.C）——由路由 requireSseAuth preHandler 守，不在本插件。
//   业务事件跟流（Redis Streams XADD 桥接）本期可空：协议为真，业务事件源 Phase 3 接 redisHot.xread。
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  type SSEEventType,
  type SSEFrame,
  type SSEStreamKind,
  type StateSnapshotPayload,
} from '@cb/shared';
import { currentTraceparent } from '../observability/node.js';

/** 取 Last-Event-ID（脊柱 §5.4：fetch-event-source 重连自动带此头）。 */
export function getLastEventId(req: FastifyRequest): string | undefined {
  const h = req.headers['last-event-id'];
  if (typeof h === 'string' && h.length > 0) return h;
  if (Array.isArray(h) && h.length > 0) return h[0];
  return undefined;
}

/** 单帧写入：遵脊柱 §5.3 标准 SSE 格式（id/event/data）。 */
export function writeSseFrame(
  reply: FastifyReply,
  frame: { id?: string; event: SSEEventType; payload: unknown },
): void {
  const lines: string[] = [];
  if (frame.id) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.payload)}`);
  lines.push('', ''); // 帧间空行
  reply.raw.write(lines.join('\n'));
}

/**
 * 具名 heartbeat 帧（脊柱 §5.5 / Codex#5）：`event: heartbeat` + `data: {ts}`。
 *   前端 EventSource addEventListener('heartbeat') 收得到 → watchdog 复位（空业务流不再 30s 反复重连）。
 *   不带 id（不进 Last-Event-ID 续传序，纯探活），不裸用 SSE comment（: hb 不可观测）。
 */
function writeHeartbeat(reply: FastifyReply): void {
  writeSseFrame(reply, { event: 'heartbeat', payload: { ts: Date.now() } });
}

/**
 * Last-Event-ID 窗口补发结果（脊柱 §5.4）。
 *   - inWindow=true：id 仍在 Stream 窗口内，frames 是该 id 之后的增量（不重推 snapshot）。
 *   - inWindow=false：超窗（id 已被裁剪）或无 Last-Event-ID → 调用方先推 snapshot 再续流。
 */
export interface ReplayResult {
  inWindow: boolean;
  frames: SSEFrame[];
}

/** 建流入参：kind + 首帧 snapshot 取数 + 可选 Last-Event-ID 窗口补发（脊柱 §5.2/§5.4）。 */
export interface SseStreamOptions {
  kind: SSEStreamKind;
  /** 计算首帧 state_snapshot 全量（脊柱 §5.2）。 */
  loadSnapshot: () => Promise<StateSnapshotPayload>;
  /** Last-Event-ID（重连补发用，脊柱 §5.4）。 */
  lastEventId?: string;
  /**
   * Last-Event-ID 窗口补发（脊柱 §5.4）：给了 lastEventId 时调用，
   * 返回是否在窗口内 + 窗口内增量帧。缺省（未接 Redis Streams）= 视为超窗（走 snapshot 重置）。
   */
  replaySince?: (lastEventId: string) => Promise<ReplayResult>;
  /**
   * 持续订阅业务流（Codex P0-1）：建流后从 fromId 起持续读 Redis Stream，把 worker 后续帧
   * （progress、subtask、item-appended、field 系列、slow_hint、error、done）经 onFrame 实时 push 给在线连接。
   *   - fromId：订阅起点。
   *       · 在窗口内 resume → 最后一帧 replayed id（无新帧则 = lastEventId）。
   *       · snapshot 路径 → 建流前抓取的流最新 id（gap-free：之后的帧必被订阅捕获）。
   *   - signal：startSseStream 在客户端断开或收到终态帧时 abort，订阅据此清理 reader、断独立连接。
   *   缺省（未接 Streams 或测试）= 不订阅，仅 snapshot 加心跳（协议仍为真，但收不到后续业务帧）。
   *   收到 done 帧视为终态，由 startSseStream 关流；error 帧从不在订阅路径关流（job/import/extract 流其后紧跟 done；
   *     结构化流 errorIsTerminal=false，字段级 error 是软事件、Job 继续，见 errorIsTerminal）。
   */
  subscribe?: (args: {
    fromId: string;
    onFrame: (frame: SSEFrame) => void;
    signal: AbortSignal;
  }) => void | Promise<void>;
  /**
   * 订阅起点 id（snapshot 路径用）：建流前由调用方抓取的流最新 id（见 RedisEventStream.latestId）。
   *   resume 在窗口内时 startSseStream 改用最后一帧 replayed id，本字段被忽略。
   */
  subscribeFromId?: string;
  /**
   * `error` 帧是否为 job 级终态前导（跨流通用语义，默认 true；Codex r7 P1）。
   *   - true（job/import/extract 等流，**保持现状不回归**）：`error` 帧是失败序列的前导（其后紧跟 `done`，
   *     脊柱 §5.3）。终态闸据「已发 error」判 terminal：若 replay 回放到 error 但缺收尾 done，则按 DB 状态
   *     补一个收尾 done 关流（不悬挂心跳）；DB failed 的 backfill 已含前导 error 时去重，不重复 error。
   *   - false（结构化 SSE，kind=structure）：`error` 帧是**软字段级失败软事件**（40 §3.4：单软字段重试 2 次
   *     仍失败落字段级 ErrorEnvelope，Job 整体可继续并最终 completed，验收 选择结构化-20/-11/-27）。**字段级
   *     error 只透传给前端、不触发终态/不合成 done failed/不关流**；结构化流的终态【仅由 DB terminalFrames()
   *     或 replay 回放到 `done` 帧 决定】。修复前：replay 到字段级 error 被当 job 终态提前收口、合成 done failed
   *     关流，破坏 SSE 真流 / resume / snapshot 后续接管（Codex r7 P1，sse.ts:221/:236）。
   */
  errorIsTerminal?: boolean;
  /**
   * 建流瞬间 DB 已是终态（snapshot 路径，Codex P0-1 集中编排）：返回应补发的终态帧序列
   *   （completed→[done]；failed→[error, done]；cancelled→[done]）。返回非空 = DB 已终态：
   *   startSseStream 写完 snapshot 后【在此处一次性补发】、由 done 帧触发关流，且【不再启动 live subscribe】。
   *   返回空 / 未提供 = 非终态（running）→ 正常 snapshot + live subscribe。
   *   终态编排全部集中在本插件，route 不再在建流后无条件补帧（杜绝双 done，Codex P0-1）。
   */
  terminalFrames?: () => Array<{ event: SSEEventType; payload: unknown }>;
  /**
   * connect-先于-job 接管（BUG-1 修复，structure 流专用）。
   *   背景：结构化流连接时该 version 可能【尚无 active job】（前端连上即看结构化状态，等用户随后发起）。
   *   旧实现此时只发 snapshot + 永久心跳，永不接管 ms 级后创建的 job、永不发 done（慢网/connect-first
   *   客户端看起来像 hang）。本钩子让插件在「无 active job、未终态」的等待路径上【周期性重查】该 version 的
   *   active/terminal structure job；一旦出现就按返回的 Activation 接管（live subscribe，或终态补 done 关流）。
   *
   *   仅在【非 resume、非 DB 终态、未启动 live subscribe】的等待路径才被调用（保住已工作情形不回归）：
   *     · 连接时已有 active job（opts.subscribe 已给）→ 走 ⑥ live subscribe，不调本钩子。
   *     · 连接时已终态（terminalFrames 非空）→ 终态闸补 done 关流，不调本钩子。
   *   返回 null = 仍无 job，继续等（下个 tick 再查）；返回 Activation = job 已出现，立即接管。
   *   signal abort（客户端断开 / 已关流）→ 轮询停止。未提供 = 维持旧「snapshot + 心跳等待」语义。
   */
  awaitActivation?: (signal: AbortSignal) => Promise<SseActivation | null>;
  /** 等待 job 出现的轮询间隔（默认 = 心跳 interval；BUG-1）。 */
  activationPollMs?: number;
  /** 心跳间隔覆盖（默认 SSE_HEARTBEAT_INTERVAL_MS）。 */
  heartbeatMs?: number;
}

/**
 * connect-先于-job 接管描述（awaitActivation 返回，BUG-1）。一旦该 version 的 structure job 出现，
 *   插件据此接管这条已开放的流——与「连接时已有 job」的 ⑥ live subscribe / 终态闸路径同形态：
 *     · terminalFrames 非空（job 已终态）→ 补发终态帧（done）并关流，绝不 subscribe（无悬挂、无双 done）。
 *     · 否则（job running）→ 从 subscribeFromId 起 live subscribe，收到 done 关流。
 *   不重推 snapshot：等待期间已发过首帧 snapshot，structure_state 增量靠 subscribe 续上（贯穿-28）。
 */
export interface SseActivation {
  /** live subscribe 起点（= 新 job 流 latestId 锚点，gap-free；终态路径忽略）。 */
  subscribeFromId: string;
  /** job running → 从锚点持续订阅其流（同 SseStreamOptions.subscribe 语义）。 */
  subscribe?: (args: {
    fromId: string;
    onFrame: (frame: SSEFrame) => void;
    signal: AbortSignal;
  }) => void | Promise<void>;
  /** job 已终态 → 应补发的终态帧（done；同 SseStreamOptions.terminalFrames 语义）。非空即不 subscribe。 */
  terminalFrames?: () => Array<{ event: SSEEventType; payload: unknown }>;
}

/** 已建立的 SSE 流句柄：可继续推业务帧（Phase 3 跟流用）+ 停止。 */
export interface SseStreamHandle {
  /** 推一帧业务事件（progress/item-appended/error/done…）。 */
  push: (frame: { id?: string; event: SSEEventType; payload: unknown }) => void;
  stop: () => void;
}

/**
 * 启动一条 SSE 流：写 SSE 响应头 → 按 Last-Event-ID 协议下发首帧 → 启心跳 → 返回句柄。
 *
 * 建流是一条【明确顺序的状态机】（Codex P0-r4，统一终态闸，终结反复出现的 SSE 边角）：
 *   ① 锚点：订阅起点 subscribeFromId（调用方建流前抓取的流最新 id；窗口内 resume 改用最后一帧 replayed id）。
 *   ② snapshot/status：调用方在锚点之后读的最新 DB 快照（loadSnapshot）与终态判定（terminalFrames）。
 *   ③ 发首帧：窗口内 replay → 补发增量（不重推 snapshot，脊柱 §5.4）；否则 → state_snapshot 重置（脊柱 §5.2）。
 *   ④ replay：窗口内则写 (Last-Event-ID, latestId] 增量；replay 帧里若含 done（或 errorIsTerminal 流的 error），
 *      记为「已发终态轨迹」。结构化流（errorIsTerminal=false）的字段级 error 是软事件，不记终态轨迹。
 *   ⑤ 【统一终态闸（subscribe 之前）】：
 *        terminal = (DB status 终态：terminalFrames() 返回非空) OR (已发 job 级 error 轨迹)。
 *        若 terminal：确保终态帧【恰好发一次】——replay 没发过就按 DB 状态补发 done/error（含
 *        Last-Event-ID==done id：replay 排除该 id 故无帧，此处按 DB 补一次），然后 stop+关流，【绝不 subscribe】。
 *        Codex r7 P1：结构化流字段级 error 不入终态轨迹 → running 时 replay 到字段级 error 仍走 ⑥ live subscribe。
 *   ⑥ 否则（running）：从锚点 live subscribe，收到 done/error 帧 → stop+关流。
 *
 *   保证：任何「非 running」路径都不 subscribe、终态帧恰好一次、无悬挂心跳、无双 done。
 * 鉴权/owner 校验须在调用前由路由 requireSseAuth preHandler + handler 完成（建流前 HTTP 失败，脊柱 §11.C）。
 */
export async function startSseStream(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: SseStreamOptions,
): Promise<SseStreamHandle> {
  // SSE 响应头：text/event-stream、关代理缓冲、长连（脊柱 §5.1）。
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx 关缓冲（脊柱 §5.1）
    [TRACE_ID_HEADER]: req.id,
    [TRACEPARENT_HEADER]: currentTraceparent(req.id),
  });
  // 防止 fastify 继续接管这个已 hijack 的响应。
  reply.hijack();

  // —— 生命周期句柄先于首帧协议定义（终态恰好处理一次）：
  //    这样 replay/snapshot 阶段命中终态时也能立即 push 终态帧 + stop（统一一条关流路径）。——
  const interval = opts.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) writeHeartbeat(reply);
  }, interval);
  // 心跳定时器不应阻止进程退出（worker/优雅关闭）。
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // 订阅生命周期：客户端断开 / 收到终态 done 帧 → abort → 订阅 reader 清理、断独立连接（防泄漏）。
  const subAbort = new AbortController();

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    // 先中止订阅（清理 XREAD reader / 独立连接），再关响应。
    if (!subAbort.signal.aborted) subAbort.abort();
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  // `error` 帧终态语义（跨流通用，Codex r7 P1）：默认 true（job/import/extract 不回归）。
  //   结构化流（kind=structure）传 false —— 字段级 error 是软事件、不参与终态闸、不去重、不关流。
  const errorIsTerminal = opts.errorIsTerminal ?? true;

  // 终态帧轨迹（统一终态闸据此「恰好一次」补发，杜绝双 done/双 error、杜绝漏发收尾 done）：
  //   - errorEmitted：失败序列的【job 级终态】error 帧已写（避免补发时重复 error）。
  //     仅当 errorIsTerminal 时才据 error 帧置位：结构化的字段级 error 是软事件，不视作终态轨迹（不收口）。
  //   - doneEmitted：收尾 done 帧已写（done 是唯一关流信号；缺它必补，否则悬挂心跳）。
  let errorEmitted = false;
  let doneEmitted = false;
  const push = (frame: { id?: string; event: SSEEventType; payload: unknown }): void => {
    if (stopped || reply.raw.writableEnded) return;
    writeSseFrame(reply, frame);
    // 仅 error=job 终态前导的流（errorIsTerminal）才记 error 轨迹；结构化字段级 error 透传但不收口。
    if (frame.event === 'error' && errorIsTerminal) errorEmitted = true;
    // 收到终态 done → 关流（前端据 done 关 EventSource；服务端这侧也收尾，不再续推）。
    // error 帧不在此关流：其后通常紧跟 done（脊柱 §5.3 失败时先 error 再 done）。
    if (frame.event === 'done') {
      doneEmitted = true;
      stop();
    }
  };

  // 客户端断开 → 清理（防泄漏：含订阅独立连接）。
  req.raw.on('close', stop);

  // —— ① 锚点 + ③④ 首帧协议（脊柱 §5.2 / §5.4）——
  //   订阅起点：默认调用方抓取的流最新 id（snapshot 路径）；窗口内 resume 则用最后一帧 replayed id。
  let resumedInWindow = false;
  let subscribeFromId = opts.subscribeFromId ?? '0-0';
  if (opts.lastEventId && opts.replaySince) {
    // 尝试窗口内补发增量（不重推 snapshot）。
    const replay = await opts.replaySince(opts.lastEventId);
    if (replay.inWindow) {
      resumedInWindow = true;
      for (const f of replay.frames) {
        // 经 push 写（而非裸 writeSseFrame）：replay 到 done 即触发 stop，并记录 done/error 已发（终态闸据此不重发）。
        push({ id: f.id, event: f.event, payload: f.payload });
      }
      // 续订从「补发的最后一帧 id」之后开始；无新帧则从 lastEventId 之后（衔接无缝、不漏不重）。
      subscribeFromId = replay.frames.at(-1)?.id ?? opts.lastEventId;
    }
  }
  if (!resumedInWindow) {
    // 超窗 / 无 Last-Event-ID / 未接 Streams → 先 state_snapshot 重置（硬规则①③，刷新/重连不打回从头）。
    //   合成帧补 id（Codex r5 非阻塞③）= 订阅锚点（subscribeFromId，调用方建流前抓取的流最新 id）。
    //   语义：「你已收齐到锚点为止的状态」。前端把它当 Last-Event-ID 重连 → replaySince 从锚点【之后】补增量，
    //   与 live subscribe 起点一致（不破坏窗口锚点、不重不漏）。锚点缺省 '0-0' 也合法（= 从头补，保守不漏）。
    const snapshot = await opts.loadSnapshot();
    writeSseFrame(reply, { id: subscribeFromId, event: 'state_snapshot', payload: snapshot });
  }

  // —— ⑤ 统一终态闸（subscribe 之前，Codex P0-r4 核心；Codex r7 P1 修正 error 终态语义）——
  //   terminal = (DB status 终态：terminalFrames() 返回非空) OR (errorEmitted)。任一为真即【绝不 subscribe】。
  //   关键：errorEmitted 仅 errorIsTerminal=true（job/import/extract）才据 error 帧置位；结构化流
  //     errorIsTerminal=false → 字段级 error 永不置 errorEmitted → 终态【仅由 DB terminalFrames() 或 replay
  //     到 done 决定】。故结构化 running 时 replay 到字段级 error 不会被本闸误收口（不合成 done failed、不关流），
  //     仍走 ⑥ live subscribe 续收 field_done/done（Codex r7 P1：sse.ts:221/:236 旧 bug 修复）。
  //   不变量：终态流必须以恰好一个 done 收尾、error 至多一次、无双发。落实如下——
  //     · doneEmitted（replay 已回放到 done）→ push 时已 stop，终态已闭合，什么都不补。
  //     · 否则若 terminal（DB 终态 或 已发过 error 但缺收尾 done）→ 按 DB 状态补发缺失的终态帧：
  //         - 已发过 error（DB failed 的失败序列 error 在前）→ 只补收尾 done，不重复 error。
  //         - 没发过 error → 按 DB 帧序补全（failed: error+done；completed/cancelled: done）。
  //       覆盖边角：snapshot 路径建流瞬间 DB 已终态 / 窗口内 replay 但没回放到 done / Last-Event-ID 恰等于 done id
  //       （replay 排除该 id 故增量为空）—— 统统在此补一次 done、stop、绝不 subscribe（旧 bug：terminalFrames 只在
  //       snapshot 分支调用，窗口内 replay 未到 done 时会跳过补帧并启动 live subscribe → 终态 job 悬挂心跳）。
  if (!doneEmitted) {
    const dbTerminalFrames = (!stopped && opts.terminalFrames?.()) || [];
    const terminal = dbTerminalFrames.length > 0 || errorEmitted;
    if (terminal) {
      // 已发过 error 就丢掉补发序列里的前导 error（避免重复 error）；无 DB 帧但已 error → 至少补一个 done 收尾。
      const backfill = errorEmitted
        ? dbTerminalFrames.filter((f) => f.event !== 'error')
        : dbTerminalFrames;
      // 合成终态帧补 id（Codex r5 非阻塞③）= 订阅锚点：与 state_snapshot 同锚点，前端以它为 Last-Event-ID
      //   重连时 replaySince 从锚点之后补（终态后通常无新帧 → 增量空，仍在窗口内不打回从头），不破坏窗口锚点。
      for (const frame of backfill) push({ id: subscribeFromId, ...frame });
      // 结构性兜底（Codex r4-P2 加固）：终态闸只要判定 terminal，就【必以一个 done 收尾、必 stop】，
      //   不依赖 terminalFrames() 一定含 done 的调用方约定。若补发序列没有 done（DB 帧畸形 / 只有前导
      //   error / 已 error 但 DB 没给收尾帧）→ 此处补一个 done 关流。done 触发 stop，故下面 subscribe 必早退。
      //   保证不变量「任何非 running 路径绝不 subscribe、绝无悬挂心跳」是结构性成立而非契约性成立。
      if (!doneEmitted) push({ id: subscribeFromId, event: 'done', payload: { status: 'failed' } });
    }
  }

  // —— ⑥ 持续订阅业务流：仅【running（非终态）】才订阅。终态闸已 stop，此处早退不订阅。——
  if (!stopped && opts.subscribe) {
    // 不 await：订阅是长循环，与本握手解耦；其内部异常吞掉（推流尽力而为，snapshot 才是真源）。
    void Promise.resolve(
      opts.subscribe({ fromId: subscribeFromId, onFrame: (f) => push(f), signal: subAbort.signal }),
    ).catch(() => undefined);
  }

  // —— ⑦ connect-先于-job 接管（BUG-1）：仅【等待路径】启动——非终态、未启动 live subscribe、给了 awaitActivation。
  //   场景：结构化流连接时该 version 尚无 active job（前端连上即看状态，等用户随后发起）。旧实现此时只
  //   snapshot + 永久心跳，永不接管 ms 级后创建的 job、永不发 done（看起来像 hang）。本轮询每 tick 重查该
  //   version 的 active/terminal structure job；一旦出现就按 Activation 接管（live subscribe 或终态补 done）。
  //   「连接时已有 job」（opts.subscribe 已起）与「连接时已终态」（已 stop）都不进此路径，旧情形零回归。
  //   job 长时间不出现 → 维持心跳等待（可接受的「等用户发起」语义）；但 job 一旦出现必接上、绝不悬挂。
  if (!stopped && !opts.subscribe && opts.awaitActivation) {
    const pollMs = opts.activationPollMs ?? interval;
    void pollForActivation(opts.awaitActivation, pollMs, subAbort.signal, push).catch(
      () => undefined,
    );
  }

  return { push, stop };
}

/**
 * connect-先于-job 接管轮询（BUG-1）。在「无 active job、未终态」的等待路径上周期性重查该 version 的
 *   structure job；出现即接管这条已开放的流，语义与「连接时已有 job」的终态闸 / live subscribe 完全对齐：
 *     · Activation.terminalFrames 非空（job 已终态）→ 补发终态帧（done）触发关流，【绝不 subscribe】。
 *     · 否则（job running）→ 从 Activation.subscribeFromId 起 live subscribe（done 关流由 push 处理）。
 *   不重推 snapshot（等待期已发首帧）；structure_state 增量靠 subscribe 续上。
 *   signal abort（客户端断开 / 已关流）→ 轮询立即退出，不泄漏定时器/连接。
 */
async function pollForActivation(
  awaitActivation: (signal: AbortSignal) => Promise<SseActivation | null>,
  pollMs: number,
  signal: AbortSignal,
  push: (frame: { id?: string; event: SSEEventType; payload: unknown }) => void,
): Promise<void> {
  while (!signal.aborted) {
    let activation: SseActivation | null = null;
    try {
      activation = await awaitActivation(signal);
    } catch {
      activation = null; // 重查异常（DB 抖动等）：尽力而为，下个 tick 再试（snapshot 仍是真源）。
    }
    if (signal.aborted) return;
    if (activation) {
      // job 已出现：接管。终态优先——补 done 关流，绝不 subscribe（无悬挂、无双 done）。
      const terminal = activation.terminalFrames?.() ?? [];
      if (terminal.length > 0) {
        for (const frame of terminal) push({ id: activation.subscribeFromId, ...frame });
        // 结构性兜底：终态接管必以 done 收尾（同 ⑤ 终态闸）。done 触发 stop。
        push({ id: activation.subscribeFromId, event: 'done', payload: { status: 'completed' } });
        return;
      }
      if (activation.subscribe) {
        // running：从锚点 live subscribe（done 关流由 push 处理；signal abort 时订阅自清理）。
        void Promise.resolve(
          activation.subscribe({
            fromId: activation.subscribeFromId,
            onFrame: (f) => push(f),
            signal,
          }),
        ).catch(() => undefined);
      }
      return; // 接管完成（subscribe 长循环已起，或终态已关流）：轮询退出。
    }
    // 仍无 job：等一个 tick 再查（可被 abort 提前唤醒，不挂住关流）。
    await delay(pollMs, signal);
  }
}

/** 可被 signal 提前唤醒的 sleep（轮询节拍用；abort 时立即 resolve，不挂住关流）。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
