// useSSE（F-02）——按 @cb/shared SSE 帧协议（脊柱 §5）消费事件流。
//
// 核心契约落地：
//   - 首帧 state_snapshot 初始化全量态（kind=job → ProgressView；kind=structure → StructureState）。
//   - Last-Event-ID 重连：记录每帧 id（= Redis Stream entry id），断线自动重连续传，超窗后端重发 state_snapshot。
//   - 心跳：heartbeat 帧用于探活，超过 2× 间隔无任何帧 → 主动重连。
//   - error 帧：完整对外 ErrorEnvelope（`{ error: {...} }`，Codex#2 / D1，不含 code），
//     与非 2xx HTTP body 同形态；解包出内层 ErrorBody，UI 只读 userMessage + action。
//   - done 帧：终止信号；命中后停止重连。
//
// 协议保真（Codex r2 P1 #7）：用 @microsoft/fetch-event-source 而非原生 EventSource。
//   - 原生 EventSource 在「看门狗主动重连」时无法给新实例带 Last-Event-ID（浏览器限制：只能浏览器自己
//     在 onerror 后自动重连时带，手动 new 一个会从头来、丢续传锚点）；旧 mock 用静态变量掩盖了该缺陷。
//   - fetchEventSource 把 Last-Event-ID 作为显式请求头自管：每次（含库内自动重连、含我们看门狗触发的重建）
//     都带上当前 lastEventId，超窗后端先推 state_snapshot 重置再续——不重不漏，真实续传语义。
//   - 鉴权走同源 Cookie（脊柱 §11.C）：credentials:'include'；建流前/握手期失效由后端以 HTTP 401 返（非帧）。
import { useEffect, useReducer, useRef } from 'react';
import { fetchEventSource, type EventSourceMessage } from '@microsoft/fetch-event-source';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  sanitizeErrorBody,
  type SSEEventType,
  type SSEStreamKind,
  type StateSnapshotPayload,
  type ProgressView,
  type StructureState,
  type ProgressPayload,
  type SubtaskView,
  type FieldStuckPayload,
  type SlowHintPayload,
  type DonePayload,
  type ErrorBody,
} from '@cb/shared';
import { clientTraceHeaders, reportClientEvent } from './telemetry.js';

/** 连接级状态机：UI 据此区分「连接中 / 流动中 / 已完成 / 错误 / 重连中」，永不裸转圈。 */
export type SSEConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'done' | 'error';

/** fetchEventSource onerror 返回的重连延迟（ms）：流中断后多久带 Last-Event-ID 重连。 */
const SSE_RECONNECT_DELAY_MS = 1_000;

export interface UseSSEState {
  kind: SSEStreamKind;
  status: SSEConnectionStatus;
  /** kind=job 全量进度真源（state_snapshot + progress 帧合并）。 */
  progress?: ProgressView;
  /** kind=structure 字段级真源（state_snapshot + field_* 帧合并）。 */
  structureState?: StructureState;
  /** field_stuck：字段卡住三退路（continue/regen/wait）。 */
  stuck?: FieldStuckPayload;
  /** slow_hint：慢提示文案（不报错，只安抚）。 */
  slowHint?: SlowHintPayload;
  /** done 帧 payload（终止状态 + 结果/错误）。 */
  done?: DonePayload;
  /** error 帧或建流失败的完整人话信封；UI 只读 userMessage + action。 */
  error?: ErrorBody;
  /** 最近收到的帧 id（= Last-Event-ID，重连续传锚点）。 */
  lastEventId?: string;
  /** 边生成边显示：item-appended 累积的追加项（kind=job）。 */
  items: unknown[];
}

type Action =
  | { type: 'connecting' }
  | { type: 'open' }
  | { type: 'reconnecting' }
  | { type: 'frame'; event: SSEEventType; id: string; payload: unknown }
  | { type: 'localError'; error: ErrorBody };

/**
 * 从 error 帧 / done.error 的完整对外 ErrorEnvelope（Codex#2：`{ error: {...} }`）白名单重建内层 ErrorBody（D1）。
 * 标准形态取 `payload.error`；容错裸 ErrorBody（带 userMessage）也认；都不像则兜底人话（永不裸转圈/裸错）。
 * 关键：经 {@link sanitizeErrorBody} 逐字段摘取，绝不强转原始帧（杜绝 code/status/stack 随帧泄漏进 state.error）。
 */
function unwrapErrorBody(payload: unknown): ErrorBody {
  if (typeof payload === 'object' && payload !== null) {
    const inner = (payload as { error?: unknown }).error;
    // 标准形态：完整 ErrorEnvelope，取内层重建。
    if (typeof inner === 'object' && inner !== null) {
      return sanitizeErrorBody(inner);
    }
  }
  // 裸 ErrorBody / 任意可疑输入：sanitizeErrorBody 内部自带白名单 + 兜底人话。
  return sanitizeErrorBody(payload);
}

function reducer(state: UseSSEState, action: Action): UseSSEState {
  switch (action.type) {
    case 'connecting':
      return { ...state, status: 'connecting' };
    case 'open':
      // 重连成功后回到 open（done 已终止则保持 done）。
      return state.status === 'done' ? state : { ...state, status: 'open' };
    case 'reconnecting':
      return state.status === 'done' ? state : { ...state, status: 'reconnecting' };
    case 'localError':
      return { ...state, status: 'error', error: action.error };
    case 'frame': {
      const next: UseSSEState = { ...state, lastEventId: action.id };
      switch (action.event) {
        case 'state_snapshot': {
          // 全量重置：首帧或重连超窗。覆盖 progress/structureState，清掉过期的瞬时态。
          const p = action.payload as StateSnapshotPayload;
          next.status = 'open';
          if (p.progress) {
            next.progress = p.progress;
            // 已生成候选/数组项不丢（Codex r2 P1 #6）：用 snapshot 全量 progress.items 重置 state.items，
            // 让刷新/超窗恢复后「边生成边显示」的卡片原样回显（item-appended 增量在此基础上续）。
            next.items = p.progress.items ?? [];
          }
          if (p.structureState) next.structureState = p.structureState;
          // 三退路重建（40 §3.5「state_snapshot 能重建三退路状态」）：断线/超窗重连时后端快照携
          // structure_state[field].status='stuck'(+stuckMs)，但顶层瞬时 stuck payload 已随旧连接丢失。
          // 若不从快照派生回 stuck payload，buildSoftFields 虽能据字段 status='stuck' 渲染可手填编辑器，
          // 但 SlowHint 的 continue/regen/wait 三退路按钮（读 sse.stuck）不会重建——等于断线后退路消失。
          // 故从 fields 找首个 status==='stuck' 的软字段，重建 FieldStuckPayload（elapsedMs 取 stuckMs ?? 0，
          // options 恒为契约三退路），与 StructureStepPage handleStuckChoice 读的 field / SlowHint 读的
          // elapsedMs/options 完全对齐；无 stuck 字段才清空（不残留过期退路）。
          const stuckField = next.structureState?.fields.find((f) => f.status === 'stuck');
          next.stuck = stuckField
            ? {
                field: stuckField.field,
                elapsedMs: stuckField.stuckMs ?? 0,
                options: ['continue', 'regen', 'wait'],
              }
            : undefined;
          return next;
        }
        case 'progress': {
          const p = action.payload as ProgressPayload;
          const prev = state.progress;
          next.progress = {
            percent: p.percent,
            phrase: p.phrase,
            ...(p.done !== undefined ? { done: p.done } : {}),
            ...(p.total !== undefined ? { total: p.total } : {}),
            ...(p.unit !== undefined ? { unit: p.unit } : {}),
            ...(p.metrics !== undefined
              ? { metrics: { ...(prev?.metrics ?? {}), ...p.metrics } }
              : prev?.metrics !== undefined
                ? { metrics: prev.metrics }
                : {}),
            subtasks: prev?.subtasks ?? [],
            ...(prev?.items !== undefined ? { items: prev.items } : {}),
          };
          next.slowHint = undefined;
          return next;
        }
        case 'subtask': {
          // subtask 帧两种契约形态（脊柱 §5.3 / 30 §3.1，Codex r2 P1 #3），无 progress 则忽略：
          //   (a) 全量 `{ subtasks: SubtaskView[] }`——整表替换/合并（不写 undefined 子任务）；
          //   (b) 单条 `{ key, status, label? }`——按 key 合并；后端实际只发 { key, status }（runner.ts），
          //       单条缺 label 时**保留旧 label**（不被 undefined 覆盖），新建项无旧 label 兜底用 key。
          if (!next.progress) return next;
          const payload = action.payload as
            | { subtasks: SubtaskView[] }
            | { key: string; status: string; label?: string };

          if (Array.isArray((payload as { subtasks?: unknown }).subtasks)) {
            const incoming = (payload as { subtasks: SubtaskView[] }).subtasks;
            const prev = next.progress.subtasks;
            // 全量合并：以 incoming 为序，单条缺 label 时回填旧 label（容错全量里也省 label）。
            const merged = incoming.map((s) => {
              const old = prev.find((p) => p.key === s.key);
              return {
                key: s.key,
                label: s.label ?? old?.label ?? s.key,
                status: s.status,
              } satisfies SubtaskView;
            });
            next.progress = { ...next.progress, subtasks: merged };
            return next;
          }

          const single = payload as { key: string; status: string; label?: string };
          const subtasks = next.progress.subtasks.slice();
          const idx = subtasks.findIndex((s) => s.key === single.key);
          const status = single.status as SubtaskView['status'];
          if (idx >= 0) {
            // 缺 label 保留旧 label（不被 undefined 覆盖）。
            subtasks[idx] = {
              key: single.key,
              label: single.label ?? subtasks[idx]!.label,
              status,
            };
          } else {
            subtasks.push({ key: single.key, label: single.label ?? single.key, status });
          }
          next.progress = { ...next.progress, subtasks };
          return next;
        }
        case 'item-appended': {
          // item-appended 按流类型两套形态（Codex r2 P1 #4）：
          //   - kind=job（提取/导入，30 §3.2 / runner.ts）：payload = `{ item: CandidateItem }`，
          //     append **payload.item**（不是整 payload，否则卡片多套一层 {item}）。
          //   - kind=structure（数组字段逐条，40 §3.2 / structure.ts）：payload = `{ field, itemIndex, value }`，
          //     按 field 把 value 补进该字段 value 数组的第 itemIndex 位（不进 state.items）。
          if (state.kind === 'structure') {
            const ap = action.payload as { field: string; itemIndex: number; value: unknown };
            const ss = state.structureState;
            if (ss && typeof ap.field === 'string' && typeof ap.itemIndex === 'number') {
              const fields = ss.fields.slice();
              const idx = fields.findIndex((x) => x.field === ap.field);
              const prevVal = idx >= 0 ? fields[idx]!.value : undefined;
              const arr = Array.isArray(prevVal) ? (prevVal as unknown[]).slice() : [];
              arr[ap.itemIndex] = ap.value;
              const base =
                idx >= 0
                  ? fields[idx]!
                  : {
                      field: ap.field,
                      status: 'generating' as StructureState['fields'][number]['status'],
                    };
              const entry: StructureState['fields'][number] = { ...base, value: arr };
              if (idx >= 0) fields[idx] = entry;
              else fields.push(entry);
              next.structureState = { ...ss, fields };
            }
            return next;
          }
          // job 流：取 payload.item 累积（边生成边显示候选/段，硬规则③）。
          const jp = action.payload as { item?: unknown };
          const item =
            jp && typeof jp === 'object' && 'item' in jp ? (jp as { item: unknown }).item : jp;
          next.items = [...state.items, item];
          return next;
        }
        case 'field_start':
        case 'field_delta':
        case 'field_done': {
          // 字段流按 field 合并进 structureState.fields（断点续传回显由 state_snapshot 兜底）。形态（40 §3.2）：
          //   - field_start `{ field, index?, total? }`：该字段转 generating（不带值）。
          //   - field_delta `{ field, deltaText, itemIndex? }`：**累积 deltaText** 到当前 value（边生成边显示，
          //     单值字段拼成 partial 文本；不是整体 value 替换，Codex r2 P1 #5）。
          //   - field_done  `{ field, value }`：写入终值（单值字符串 / 数组），转 done。
          const f = action.payload as {
            field: string;
            deltaText?: string;
            value?: unknown;
          };
          const ss = state.structureState;
          if (ss) {
            const fields = ss.fields.slice();
            const idx = fields.findIndex((x) => x.field === f.field);
            const prev = idx >= 0 ? fields[idx] : undefined;

            const status = (
              action.event === 'field_done' ? 'done' : 'generating'
            ) as StructureState['fields'][number]['status'];

            // 计算本帧后该字段的 value。
            let value: unknown;
            if (action.event === 'field_done') {
              value = f.value; // 终值（可能是 string | string[]）。
            } else if (action.event === 'field_delta') {
              // 累积 deltaText 到 partial 文本（前值非字符串则从空串起拼，不污染数组型已生成项）。
              const base = typeof prev?.value === 'string' ? prev.value : '';
              value = base + (f.deltaText ?? '');
            } else {
              // field_start：保留已生成 partial（断点续传时不打回），无则不带 value。
              value = prev?.value;
            }

            const entry: StructureState['fields'][number] = {
              field: f.field,
              status,
              ...(value !== undefined ? { value } : {}),
            };
            if (idx >= 0) fields[idx] = entry;
            else fields.push(entry);
            const doneCount = fields.filter(
              (x) => x.status === 'done' || x.status === 'locked',
            ).length;
            next.structureState = { ...ss, fields, doneCount };
          }
          if (action.event !== 'field_delta') next.stuck = undefined;
          return next;
        }
        case 'field_stuck': {
          // 卡住三退路（40 §3.3）。除保留顶层 stuck payload（驱动 SlowHint 三退路按钮）外，
          // 还把该字段在 structureState.fields 里的 status 置 'stuck'（与后端受保护写
          // structure_state[field].status='stuck'+stuckMs 一致，40 §3.5）——否则该字段仍停在
          // 'generating'，buildSoftFields 渲染骨架；continue/released 后字段冻在骨架、永远填不了
          // （永不裸转圈 / 已生成不丢：已生成 partial 仍保留进 value，只改 status）。
          const sp = action.payload as FieldStuckPayload;
          next.stuck = sp;
          const ss = state.structureState;
          if (ss && typeof sp.field === 'string') {
            const fields = ss.fields.slice();
            const idx = fields.findIndex((x) => x.field === sp.field);
            const prev = idx >= 0 ? fields[idx] : undefined;
            const entry: StructureState['fields'][number] = {
              field: sp.field,
              status: 'stuck',
              // 已生成 partial 不丢（边生成边显示的内容继续可见）。
              ...(prev?.value !== undefined ? { value: prev.value } : {}),
              ...(prev?.attempts !== undefined ? { attempts: prev.attempts } : {}),
              ...(sp.elapsedMs !== undefined ? { stuckMs: sp.elapsedMs } : {}),
            };
            if (idx >= 0) fields[idx] = entry;
            else fields.push(entry);
            next.structureState = { ...ss, fields };
          }
          return next;
        }
        case 'slow_hint': {
          next.slowHint = action.payload as SlowHintPayload;
          return next;
        }
        case 'error': {
          // error 帧 = 完整对外 ErrorEnvelope（Codex#2：`{ error: {...} }`，不含 code）。
          // 解包出内层 ErrorBody；UI 只读 userMessage + action。
          next.status = 'error';
          next.error = unwrapErrorBody(action.payload);
          return next;
        }
        case 'done': {
          // done 帧 = 终止信号。失败终态时 payload.error 携完整对外 ErrorEnvelope（Codex#2，不含 code），
          // 解包进 state.error 让统一错误态一处通吃（HTTP / error 帧 / done 失败同一渲染路径）。
          const d = action.payload as DonePayload;
          next.done = d;
          if (d.error) {
            next.status = 'error';
            next.error = unwrapErrorBody(d.error);
          } else {
            next.status = 'done';
          }
          return next;
        }
        case 'heartbeat':
          // 探活帧：不改业务态，仅刷新 lastEventId（已在上面做）+ 看门狗在 effect 里复位。
          return next;
        default:
          return next;
      }
    }
    default:
      return state;
  }
}

export interface UseSSEOptions {
  /** false 时不建流（如 jobId 尚未就绪）。 */
  enabled?: boolean;
}

/** 全部 12 帧类型集合（校验 msg.event ∈ 协议，过滤未知事件名；不重不漏守门）。 */
const SSE_EVENT_SET: ReadonlySet<string> = new Set<SSEEventType>([
  'state_snapshot',
  'progress',
  'subtask',
  'item-appended',
  'field_start',
  'field_delta',
  'field_done',
  'field_stuck',
  'slow_hint',
  'error',
  'done',
  'heartbeat',
]);

/**
 * 注入点（Codex r2 P1 #7）：默认用全局 `fetchEventSource`；测试经此 seam 换受控 mock，
 * 验证「断线后带正确 Last-Event-ID 续接、不重不漏」真实重连语义（不再靠静态变量掩盖原生 EventSource 缺陷）。
 */
export type FetchEventSourceFn = typeof fetchEventSource;
let fetchEventSourceImpl: FetchEventSourceFn = fetchEventSource;
/** 仅测试用：替换底层 fetchEventSource 实现，返回还原函数。 */
export function __setFetchEventSourceForTests(fn: FetchEventSourceFn): () => void {
  const prev = fetchEventSourceImpl;
  fetchEventSourceImpl = fn;
  return () => {
    fetchEventSourceImpl = prev;
  };
}

/** 致命错误：让 fetchEventSource 的 onerror 抛它即停止自动重连（鉴权失败/done 后不该再连）。 */
class SSEFatalError extends Error {}

/**
 * 订阅一条 SSE 流（job 或 structure）。
 * @param url   SSE 端点（用 shared 的 SSE_ROUTES.jobEvents / structureEvents 构造）。
 * @param kind  流类型，决定 state_snapshot 解析哪一型。
 */
export function useSSE(
  url: string | null,
  kind: SSEStreamKind,
  options: UseSSEOptions = {},
): UseSSEState {
  const enabled = options.enabled !== false && !!url;

  const [state, dispatch] = useReducer(reducer, {
    kind,
    status: 'connecting',
    items: [],
  } satisfies UseSSEState);

  // 看门狗：超过 2× 心跳间隔无任何帧 → 主动断开重连。fetchEventSource 重连会自带当前 Last-Event-ID 头
  // （我们维护 lastEventIdRef 显式回填），超窗后端先推 state_snapshot 重置——真实续传，永不裸转圈。
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef(false);
  // 显式续传锚点：每帧更新；重连（库内自动 / 看门狗触发）都带它做 Last-Event-ID 头。
  const lastEventIdRef = useRef<string>('');

  useEffect(() => {
    if (!enabled || !url) return;

    doneRef.current = false;
    lastEventIdRef.current = '';
    let closed = false;
    const trace = clientTraceHeaders();
    // 当前连接的 AbortController：看门狗超时 / cleanup 用它断流，触发库内重连或彻底停止。
    let ctrl = new AbortController();

    const clearWatchdog = () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };

    const armWatchdog = () => {
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        if (closed || doneRef.current) return;
        // 超时无帧：断开当前连接并以当前 Last-Event-ID 重连（不裸转圈，标 reconnecting）。
        dispatch({ type: 'reconnecting' });
        const old = ctrl;
        ctrl = new AbortController();
        old.abort(); // abort 旧流；下面 connect() 用新 ctrl + 当前 lastEventId 续接。
        connect();
      }, SSE_HEARTBEAT_INTERVAL_MS * 2);
    };

    const connect = () => {
      dispatch({ type: 'connecting' });
      const signal = ctrl.signal;

      void fetchEventSourceImpl(url, {
        signal,
        credentials: 'include', // 同源 Cookie 鉴权（脊柱 §11.C）。
        openWhenHidden: true, // 后台标签页不暂停流（任务可能仍在跑）。
        // 显式带续传锚点：库内部也会用它，但我们重连前手动设以保证「看门狗重建」也续接（不丢窗口）。
        headers: {
          ...trace.headers,
          ...(lastEventIdRef.current ? { 'Last-Event-ID': lastEventIdRef.current } : {}),
        },

        async onopen(response: Response) {
          if (closed) return;
          // 协议握手校验（Codex r2 P1）：自定义 onopen 替换了库默认的 content-type 校验，必须自己把关。
          //   - 后端 SSE 鉴权/权限失败按契约在「建流前」返回 HTTP ErrorEnvelope（401/403，非 event-stream），
          //     不走 error 帧；此处若盲目当流 open + arm watchdog，非 event-stream 响应会被当可重连流，
          //     永远进不了统一错误态，也不白名单展示 HTTP ErrorEnvelope。
          const contentType = response.headers.get('content-type') ?? '';
          if (!response.ok || !contentType.includes('text/event-stream')) {
            // 非 2xx 或非 event-stream：解析 HTTP body 为 ErrorEnvelope，白名单重建（无 code/status/stack/message）
            // 进统一错误态。鉴权/权限失败不重连——设终止标志 + 抛 SSEFatalError，onerror 据此 throw 停止库内重连。
            let body: unknown;
            try {
              body = await response.clone().json();
            } catch {
              body = undefined; // 非 JSON body：unwrapErrorBody 兜底人话（永不裸错）。
            }
            const error = unwrapErrorBody(body);
            reportClientEvent('sse_error', {
              traceId: error.traceId || trace.traceId,
              message: error.userMessage,
              url,
            });
            doneRef.current = true; // 终止：鉴权失败不重连。
            clearWatchdog();
            dispatch({ type: 'localError', error });
            // 抛致命错误：库 create() 捕获后交 onerror，onerror 见 SSEFatalError 再抛 → 彻底停止重连。
            throw new SSEFatalError('sse open failed');
          }
          // 2xx + event-stream：正常 open（网络瞬断仍可重连，看门狗逻辑保留）。
          dispatch({ type: 'open' });
          armWatchdog();
        },

        onmessage(msg: EventSourceMessage) {
          if (closed) return;
          armWatchdog();
          // 续传锚点：每帧 id（= Redis Stream entry id）更新（库也会回填请求头，我们这份给看门狗重建用）。
          if (msg.id) lastEventIdRef.current = msg.id;
          const evt = msg.event;
          if (!SSE_EVENT_SET.has(evt)) return; // 未知事件名（含空 message）忽略，不污染状态机。
          let payload: unknown;
          try {
            payload = msg.data ? JSON.parse(msg.data) : undefined;
          } catch {
            payload = msg.data; // 非 JSON（理论上不应发生）：保留原文，不致命。
          }
          dispatch({ type: 'frame', event: evt as SSEEventType, id: msg.id, payload });
          if (evt === 'error') {
            const error = unwrapErrorBody(payload);
            reportClientEvent('sse_error', {
              traceId: error.traceId || trace.traceId,
              message: error.userMessage,
              url,
            });
          }
          if (evt === 'done') {
            const done = payload as DonePayload | undefined;
            if (done?.error) {
              const error = unwrapErrorBody(done.error);
              reportClientEvent('sse_error', {
                traceId: error.traceId || trace.traceId,
                message: error.userMessage,
                url,
              });
            }
          }
          if (evt === 'done') {
            // 终止：标记 + 抛致命错误停止库内自动重连 + 断流。
            doneRef.current = true;
            clearWatchdog();
            ctrl.abort();
          }
        },

        onerror(err) {
          // 致命错误（done 后 / 主动停）→ 抛出停止重连；其余 → 返回重连延迟（库自动按 Last-Event-ID 重连）。
          if (err instanceof SSEFatalError) throw err;
          if (closed || doneRef.current) throw new SSEFatalError('closed');
          // 网络/流中断：库会自动重连（带 Last-Event-ID 头）；UI 标 reconnecting（永不裸转圈/裸错）。
          dispatch({ type: 'reconnecting' });
          armWatchdog();
          return SSE_RECONNECT_DELAY_MS;
        },

        onclose() {
          // 服务端关流（非 done）：库视为可重连；除非已 done/closed，否则让看门狗兜底重连。
          if (closed || doneRef.current) return;
          dispatch({ type: 'reconnecting' });
          armWatchdog();
        },
      }).catch(() => {
        // fetchEventSource 在 onerror 抛致命错误时 reject——预期内（done/cleanup），吞掉不外溢。
      });
    };

    const cleanup = () => {
      closed = true;
      doneRef.current = true;
      clearWatchdog();
      ctrl.abort();
    };

    connect();
    return cleanup;
  }, [url, enabled]);

  return state;
}
