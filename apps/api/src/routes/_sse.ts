// SSE 路由 handler 工厂（脊柱 §5 / §11.C，Codex#3）。
//   两条本期可调用 SSE 流共用：建流前 owner 校验（HTTP 失败、不走 error 帧）+ 真实 text/event-stream。
//   - job 流（/jobs/:jobId/events）：snapshot = jobs.progress 全量（kind=job）。
//   - structure 流（/versions/:versionId/structure/events）：snapshot = capability_versions.structure_state 全量（kind=structure）。
//   鉴权已由 requireSseAuth（同源 Cookie）前置；本 handler 只做 owner 校验 + 建流。
//   业务事件跟流（Redis Streams XADD）本期可空（协议为真）；DB 取不到资源 → 建流前 404/403 HTTP。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  isTerminalJobStatus,
  SOFT_FIELD_KEYS,
  type ErrorBody,
  type JobStatus,
  type ProgressView,
  type SoftFieldKey,
  type StateSnapshotPayload,
  type StructureState,
} from '@cb/shared';
import { startSseStream } from '../plugins/sse.js';
import { getLastEventId } from '../plugins/sse.js';
import type { SseActivation } from '../plugins/sse.js';
import { RedisEventStream } from '../sse/event-stream.js';

/**
 * connect-先于-job 接管重查节拍（BUG-1）。结构化流连接时该 version 可能尚无 active job
 *   （前端连上即看状态，等用户随后发起）；插件在等待路径每此间隔重查一次该 version 的 structure job，
 *   一旦出现即接管（live subscribe / 补 done 关流），不再依赖客户端重连。
 *   取 1s：connect-先于-job 是 ms 级竞态，接管要够快（「job 一旦出现必须接上」），又不过度打 DB。
 *   测试可经 STRUCTURE_ACTIVATION_POLL_MS 读到此真源，无需依赖 15s 心跳节拍。
 */
export const STRUCTURE_ACTIVATION_POLL_MS = 1_000;

/** 建流前资源查找结果：owner 校验用。 */
interface OwnerLookup {
  found: boolean;
  ownerUserId?: string;
}

/** 建流前 404（资源不存在，HTTP 信封，不走 error 帧，脊柱 §11.C）。 */
function reply404(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
}

/** 建流前 403（非 owner，HTTP 信封，脊柱 §11.C / 10-auth §6.3）。 */
function reply403(req: FastifyRequest, reply: FastifyReply): void {
  reply
    .code(403)
    .send(buildError(ErrorCode.FORBIDDEN, req.id, { userMessage: '你没有权限查看这个内容。' }));
}

/** 建流前 500（依赖异常兜底，HTTP 信封；绝不裸露原始报错，脊柱 §11.B）。 */
function reply500(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
}

/**
 * job 流 SSE handler（脊柱 §5，kind=job）。
 *   建流前：查 jobs（owner=当前用户），缺则 404、非 owner 则 403（HTTP，脊柱 §11.C）；
 *   建流：首帧 state_snapshot = jobs.progress 全量（断点续传基座，硬规则①③）。
 */
export function jobSseHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { jobId } = req.params as { jobId: string };
    const userId = req.auth?.userId;
    if (!userId) {
      // requireSseAuth 已保证有 auth；防御性兜底。
      reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
      return reply;
    }

    // —— 建流前 owner 校验：只读 owner 字段（不读 progress/status，避免与下方 snapshot 取数耦合，
    //    且让 owner 校验是最便宜的一跳；Codex P0-1）。缺则 404、非 owner 则 403（HTTP，脊柱 §11.C）。——
    let ownerRow: { owner_user_id: string } | undefined;
    try {
      const res = await req.server.infra.db.query<{ owner_user_id: string }>(
        'SELECT owner_user_id FROM jobs WHERE id = $1',
        [jobId],
      );
      ownerRow = res.rows[0];
    } catch {
      reply500(req, reply);
      return reply;
    }

    const lookup: OwnerLookup = ownerRow
      ? { found: true, ownerUserId: ownerRow.owner_user_id }
      : { found: false };
    if (!lookup.found) {
      reply404(req, reply);
      return reply;
    }
    if (lookup.ownerUserId !== userId) {
      reply403(req, reply);
      return reply;
    }

    const stream = new RedisEventStream(req.server.infra.redisHot);

    // —— TOCTOU 消除（Codex P0-1）：**先取 stream latest id（订阅锚点），再读最新 job snapshot/status**。
    //    顺序反过来保证 snapshot 不早于 latestId 锚点：worker 在「读 snapshot」之后 XADD 的帧，其 id 必 >
    //    latestId，会被从 latestId 起的持续订阅捕获（不漏）；snapshot 已含的进展，订阅重叠一两帧由前端按
    //    percent/状态幂等吸收（不重不卡）。若先读 snapshot 再取 latestId，则两者间 XADD 的 progress/done
    //    会两头漏（不在 snapshot、也不在 latestId 之后），done 漏掉会让连接只剩心跳、不关流。
    const subscribeFromId = await stream.latestId(jobId).catch(() => '0-0');

    // snapshot/status 取数：在 latestId 锚点【之后】读，保证 snapshot 不早于锚点（gap-free 衔接）。
    let snapRow: { status: string; progress: unknown; result: unknown; error: unknown } | undefined;
    try {
      const res = await req.server.infra.db.query<{
        status: string;
        progress: unknown;
        result: unknown;
        error: unknown;
      }>('SELECT status, progress, result, error FROM jobs WHERE id = $1', [jobId]);
      snapRow = res.rows[0];
    } catch {
      reply500(req, reply);
      return reply;
    }
    // 取 snapshot 时 job 已被删（极少）→ 404（仍未建流）。
    if (!snapRow) {
      reply404(req, reply);
      return reply;
    }

    const progress = (snapRow.progress ?? {}) as Partial<ProgressView>;
    const status = snapRow.status as JobStatus;

    // 建流（hijack 后由 startSseStream 接管 raw）。snapshot = jobs.progress（kind=job）。
    // Last-Event-ID 窗口补发接 redis_hot Streams（B-12）：窗口内补增量、超窗走 snapshot 重置（脊柱 §5.4）。
    //
    // —— 终态编排全部交给 startSseStream（Codex P0-1 集中编排，杜绝双 done）——
    //   route 不再在建流后无条件 handle.push 终态帧：
    //     · replay 命中 done/error → 插件内 push 触发关流、不再订阅；
    //     · snapshot 阶段 DB 已终态 → 插件用 terminalFrames() 补一次终态帧并关流、不订阅；
    //     · running → snapshot + 从锚点 live subscribe，收到 done 即关流。
    //   终态帧只发一次、无重复、无悬挂；snapshot 已锚定在 latestId 之后，故终态判定与首帧一致。
    await startSseStream(req, reply, {
      kind: 'job',
      lastEventId: getLastEventId(req),
      loadSnapshot: async (): Promise<StateSnapshotPayload> => ({
        kind: 'job',
        progress: normalizeProgress(progress),
      }),
      replaySince: (lastEventId) => stream.replaySince(jobId, lastEventId),
      // 建流后持续订阅 events:job:{jobId}：把 worker 后续帧实时 push 给在线连接；
      // 断开 / done 终态由 startSseStream abort signal 清理 reader、断独立连接（Codex P0-1）。
      subscribeFromId,
      subscribe: ({ fromId, onFrame, signal }) => stream.subscribe(jobId, fromId, onFrame, signal),
      // 建流瞬间 job 已终态：返回对应终态帧（completed→done；failed→error+done；cancelled→done），
      //   由 startSseStream 在 snapshot 后一次性补发并关流（不留只剩心跳的悬挂连接）。非终态返回空。
      terminalFrames: () =>
        isTerminalJobStatus(status) ? terminalFrames(status, snapRow.result, snapRow.error) : [],
    });
    return reply;
  };
}

/**
 * structure 流 SSE handler（脊柱 §5，kind=structure；Codex P0-1 真流）。
 *   建流前：查 capability_versions JOIN capabilities（owner=creator_user_id），缺 404、非 owner 403。
 *   建流：首帧 state_snapshot = structure_state 全量（从 structure_state 重建，含各软字段 done/generating/stuck/
 *     failed + attempts；硬字段 locked，字段级断点续传、已生成不丢）。
 *   真流映射（核心修复）：worker 把 field_* / item-appended / field_stuck / error / done 帧写 events:job:{jobId}
 *     （ctx.emitField），故本 SSE 把结构化流【可靠映射到该 version 的 active structure job】并订阅其 job stream：
 *       - latestId 锚点（active job 流）→ snapshot（structure_state）→ 从锚点 live subscribe（同 3A 时序消 TOCTOU）；
 *       - Last-Event-ID 在窗补增量、超窗回落 snapshot（replaySince 接 active job 流）；
 *       - 具名 heartbeat（startSseStream 内）；
 *       - 统一终态闸：active job 已终态 / 无 active job 但有终态历史 job → snapshot 后补 done 关流、绝不 subscribe。
 *     无任何 structure job（尚未发起结构化）→ 仅 snapshot + heartbeat，流保持开放（前端连上即有结构化状态，
 *       等用户发起后 worker 推帧；非 running 不 subscribe，靠下次重连续上）。
 */
export function structureSseHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { versionId } = req.params as { versionId: string };
    const userId = req.auth?.userId;
    if (!userId) {
      reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
      return reply;
    }

    // —— 建流前 owner 校验（只读 owner，缺 404 / 非 owner 403，脊柱 §11.C）——
    let ownerRow: { creator_user_id: string } | undefined;
    try {
      const res = await req.server.infra.db.query<{ creator_user_id: string }>(
        `SELECT c.creator_user_id AS creator_user_id
           FROM capability_versions v
           JOIN capabilities c ON c.id = v.capability_id
          WHERE v.id = $1`,
        [versionId],
      );
      ownerRow = res.rows[0];
    } catch {
      reply500(req, reply);
      return reply;
    }
    if (!ownerRow) {
      reply404(req, reply);
      return reply;
    }
    if (ownerRow.creator_user_id !== userId) {
      reply403(req, reply);
      return reply;
    }

    // —— 映射 active structure job（订阅锚点 / 终态判定）：取该 version 最近一条 structure job。
    //    优先未终态（queued/running，可 live subscribe）；否则最近一条终态（补 done 关流，统一终态闸）。——
    let jobRow: StructureJobRow | undefined;
    try {
      jobRow = await lookupStructureJob(req.server.infra.db, versionId, userId);
    } catch {
      reply500(req, reply);
      return reply;
    }

    const stream = new RedisEventStream(req.server.infra.redisHot);
    const jobId = jobRow?.id;
    const jobStatus = jobRow?.status as JobStatus | undefined;
    const isActive = jobStatus === 'queued' || jobStatus === 'running';

    // —— TOCTOU 消除（同 3A）：先取 active job 流 latestId 锚点，再读 structure_state snapshot。——
    //    无 active job（无 job / 终态）→ 锚点 '0-0'（不 subscribe，仅 snapshot + 终态闸/heartbeat）。
    const subscribeFromId =
      jobId && isActive ? await stream.latestId(jobId).catch(() => '0-0') : '0-0';

    // —— snapshot 取数：在锚点之后读 structure_state（gap-free，已生成字段/stuck/failed/attempts 全回显）——
    let structureState: Partial<StructureState> = {};
    try {
      const res = await req.server.infra.db.query<{ structure_state: unknown }>(
        `SELECT structure_state FROM capability_versions WHERE id = $1`,
        [versionId],
      );
      const r = res.rows[0];
      if (!r) {
        reply404(req, reply);
        return reply;
      }
      structureState = (r.structure_state ?? {}) as Partial<StructureState>;
    } catch {
      reply500(req, reply);
      return reply;
    }

    await startSseStream(req, reply, {
      kind: 'structure',
      // 字段级 error 是软事件、非 job 终态（40 §3.4：单软字段重试 2 次仍失败落字段级 ErrorEnvelope，
      //   Job 整体可继续并最终 completed，验收 选择结构化-20/-11/-27）。errorIsTerminal=false →
      //   结构化流的 error 帧只透传、不触发终态闸/不合成 done failed/不关流；终态仅由 active job 终态
      //   （terminalFrames）或 replay 到 done 决定。修复前 replay 到字段级 error 被提前收口（Codex r7 P1）。
      errorIsTerminal: false,
      lastEventId: getLastEventId(req),
      loadSnapshot: async (): Promise<StateSnapshotPayload> => ({
        kind: 'structure',
        structureState: normalizeStructureState(versionId, structureState),
      }),
      // Last-Event-ID 窗口补发接 active job 流（无 active job → 无 replaySince，走 snapshot 重置）。
      ...(jobId && isActive
        ? { replaySince: (lastEventId: string) => stream.replaySince(jobId, lastEventId) }
        : {}),
      subscribeFromId,
      // 仅 active（queued/running）才 live subscribe active job 流；非 running 不订阅（统一终态闸，硬要求）。
      ...(jobId && isActive
        ? {
            subscribe: ({ fromId, onFrame, signal }) =>
              stream.subscribe(jobId, fromId, onFrame, signal),
          }
        : {}),
      // 统一终态闸：active job 不存在（无 job / 终态）→ 据 DB 终态补 done 关流（completed/failed/cancelled）。
      //   structure 流的终态以「该 version 的 structure job 终态」为准；无 job → 不发终态（保持开放等发起）。
      terminalFrames: () =>
        jobStatus && isTerminalJobStatus(jobStatus)
          ? [{ event: 'done' as const, payload: { status: jobStatus } }]
          : [],
      // —— connect-先于-job 接管（BUG-1）：仅【连接时完全无 job】才挂轮询接管钩子——
      //   连接时已有 job（active 走上面 subscribe / 终态走 terminalFrames）一律不挂，旧情形零回归。
      //   连接时无 job：流先发 snapshot 保持开放，本钩子每 tick 重查该 version 的 structure job；
      //   一旦出现（active → live subscribe；已终态 → 补 done 关流）就接管，不再依赖客户端重连。
      ...(jobRow
        ? {}
        : {
            awaitActivation: (signal) =>
              awaitStructureActivation(req.server.infra.db, stream, versionId, userId, signal),
            activationPollMs: STRUCTURE_ACTIVATION_POLL_MS,
          }),
    });
    return reply;
  };
}

/** 该 version 最近一条 structure job（owner 限定）：优先未终态、否则最近终态（lookupStructureJob 真源）。 */
interface StructureJobRow {
  id: string;
  status: string;
}

/**
 * 取该 version 的「映射 structure job」（建流 + 接管轮询共用真源，BUG-1）。
 *   优先未终态（queued/running，可 live subscribe）；否则最近一条终态（补 done 关流）；无任何 job → undefined。
 *   异常【向上抛】（建流前 → reply500；轮询里 → 由 pollForActivation 吞掉下个 tick 重试）。
 */
async function lookupStructureJob(
  db: FastifyRequest['server']['infra']['db'],
  versionId: string,
  userId: string,
): Promise<StructureJobRow | undefined> {
  const res = await db.query<StructureJobRow>(
    `SELECT id, status FROM jobs
        WHERE type = 'structure'
          AND owner_user_id = $2
          AND subject_ref->>'versionId' = $1
        ORDER BY (status IN ('queued','running')) DESC, created_at DESC
        LIMIT 1`,
    [versionId, userId],
  );
  return res.rows[0];
}

/**
 * connect-先于-job 接管探测（BUG-1）：插件在等待路径每 tick 调一次。重查该 version 的 structure job——
 *   · 无 job → 返回 null（继续等，下个 tick 再查；流维持 snapshot + 心跳的「等用户发起」语义）。
 *   · active（queued/running）→ 返回 Activation：先取该 job 流 latestId 锚点（gap-free），从锚点 live subscribe。
 *   · 已终态 → 返回 Activation：terminalFrames 补 done（completed/failed/cancelled），插件据此关流、绝不 subscribe。
 *   语义与「连接时已有 job」的 subscribe / 终态闸完全对齐（不重推 snapshot，structure_state 增量靠 subscribe）。
 */
async function awaitStructureActivation(
  db: FastifyRequest['server']['infra']['db'],
  stream: RedisEventStream,
  versionId: string,
  userId: string,
  signal: AbortSignal,
): Promise<SseActivation | null> {
  const jobRow = await lookupStructureJob(db, versionId, userId);
  if (!jobRow || signal.aborted) return null;
  const jobId = jobRow.id;
  const jobStatus = jobRow.status as JobStatus;
  const isActive = jobStatus === 'queued' || jobStatus === 'running';
  if (isActive) {
    // 先取锚点（同建流时序消 TOCTOU）：从锚点起 live subscribe，其后 XADD 的字段流帧必被捕获。
    const subscribeFromId = await stream.latestId(jobId).catch(() => '0-0');
    return {
      subscribeFromId,
      subscribe: ({ fromId, onFrame, signal: s }) => stream.subscribe(jobId, fromId, onFrame, s),
    };
  }
  if (isTerminalJobStatus(jobStatus)) {
    // 接管时 job 已终态（罕见：等待期间 job 极快跑完）→ 补 done 关流，绝不 subscribe（统一终态闸口径）。
    return {
      subscribeFromId: '0-0',
      terminalFrames: () => [{ event: 'done' as const, payload: { status: jobStatus } }],
    };
  }
  return null;
}

/**
 * 建流瞬间 job 已终态时补发的终态帧（Codex P0-1）。与 runner 落终态时推的帧同形态（脊柱 §5.3）：
 *   - completed → done(status, result)。
 *   - failed    → 先 error(完整 ErrorEnvelope) 再 done(status, error)（失败先 error 后 done）。
 *     jobs.error 存的是 ErrorBody（= JobView.error），故包成 { error: body } 形成对外 ErrorEnvelope。
 *   - cancelled → done(status)。
 * done 帧经 startSseStream.push 触发关流（不留只剩心跳的悬挂连接）。
 */
function terminalFrames(
  status: JobStatus,
  result: unknown,
  error: unknown,
): Array<{ event: 'error' | 'done'; payload: unknown }> {
  if (status === 'completed') {
    return [{ event: 'done', payload: { status, result: result ?? null } }];
  }
  if (status === 'failed') {
    const envelope = { error: (error ?? {}) as ErrorBody };
    return [
      { event: 'error', payload: envelope },
      { event: 'done', payload: { status, error: envelope } },
    ];
  }
  // cancelled（及理论上其它终态）：只发 done。
  return [{ event: 'done', payload: { status } }];
}

/** 把 jobs.progress（可能为 {} 或部分）规整成合法 ProgressView（永不裸转圈：至少给 0% + 子任务空清单）。 */
function normalizeProgress(p: Partial<ProgressView>): ProgressView {
  return {
    percent: typeof p.percent === 'number' ? p.percent : 0,
    phrase: typeof p.phrase === 'string' ? p.phrase : '正在准备…',
    ...(typeof p.done === 'number' ? { done: p.done } : {}),
    ...(typeof p.total === 'number' ? { total: p.total } : {}),
    ...(typeof p.unit === 'string' ? { unit: p.unit } : {}),
    subtasks: Array.isArray(p.subtasks) ? p.subtasks : [],
    ...(Array.isArray(p.items) ? { items: p.items } : {}),
    ...(typeof p.slow === 'boolean' ? { slow: p.slow } : {}),
  };
}

/**
 * 把 structure_state（可能为 {} 或部分）规整成合法 StructureState（已生成字段原样回显）。
 *   doneCount/totalCount 一律从 fields 重算（不信库内存量值）：worker surgical 写只 patch fields 数组、不刷新
 *   存量 doneCount（Codex r6 P1，避免整列写覆盖并发改动），故计数须以 fields 为唯一真源在读时派生
 *   （与 manifest.buildStructureState 同口径：done 只数软字段、硬字段 locked 不计 total）。
 */
function normalizeStructureState(versionId: string, s: Partial<StructureState>): StructureState {
  const fields = Array.isArray(s.fields) ? s.fields : [];
  const soft = fields.filter((f) => SOFT_FIELD_KEYS.includes(f.field as SoftFieldKey));
  return {
    versionId,
    fields,
    doneCount: soft.filter((f) => f.status === 'done').length,
    totalCount: soft.length,
  };
}
