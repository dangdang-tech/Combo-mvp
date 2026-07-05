// SSE（AG-UI 标准事件）归并：把 /runtime/sessions/:id/stream 的原始事件流
// 折叠成 UI 可渲染的状态。纯函数，无 IO——单测直接喂事件序列断言。
//
// 会话流是「从 Last-Event-ID 之后整段重放 + 实时」的长流：历史轮次的文本事件
// 会被重放，但每轮都以 RUN_FINISHED / RUN_ERROR 收尾——终态即清空流式文本
// （落库消息以详情接口为真源），所以重放完只剩「进行中的一轮」的实时文本。
// 产物走 STATE_DELTA（add /artifacts/<id> + /activeArtifactId），重放与详情
// 按产物 id 收敛到同一份 map，重复应用无副作用。
import { EventType } from '@ag-ui/core';
import type { ArtifactView } from '@cb/shared';

/** 线上一帧 AG-UI 事件里前端消费的字段（其余字段透传忽略）。 */
export interface StreamEvent {
  type: string;
  delta?: unknown;
  message?: string;
}

export interface StreamUiState {
  /** 后端是否正在生成（RUN_STARTED 后、终态前；发消息 202 后也乐观置起）。 */
  running: boolean;
  /** 进行中一轮的流式助手文本（打字机）；无进行中文本 → null。 */
  streamingText: string | null;
  /** 产物画布（id → 视图），详情种子 + STATE_DELTA 增量共同收敛。 */
  artifacts: Record<string, ArtifactView>;
  activeArtifactId: string | null;
  /** 可直接展示的人话错误（RUN_ERROR / 发送失败）。 */
  errorMessage: string | null;
}

export const initialStreamUiState: StreamUiState = {
  running: false,
  streamingText: null,
  artifacts: {},
  activeArtifactId: null,
  errorMessage: null,
};

export type StreamUiAction =
  | { kind: 'stream-event'; event: StreamEvent }
  | { kind: 'seed-artifacts'; artifacts: ArtifactView[] }
  | { kind: 'select-artifact'; id: string }
  /** POST messages 202 后的乐观运行态（RUN_STARTED 事件到达前顶住输入框）。 */
  | { kind: 'turn-accepted' }
  | { kind: 'error'; message: string }
  | { kind: 'reset' };

/** data: 帧原文 → 事件对象；非 JSON / 无 type → null（忽略该帧）。 */
export function parseStreamEvent(raw: string): StreamEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const event = parsed as StreamEvent;
    return typeof event.type === 'string' ? event : null;
  } catch {
    return null;
  }
}

/** 终态事件：hook 据此回拉一次会话详情对齐真源。 */
export function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
}

/** JSON Pointer 段解码（产物 id 是 UUID，通常无需转义；按规范兜住 ~0/~1）。 */
function pointerDecode(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** STATE_DELTA：JSON Patch add/replace，只认 /artifacts/<id> 与 /activeArtifactId。 */
function applyStateDelta(state: StreamUiState, delta: unknown): StreamUiState {
  if (!Array.isArray(delta)) return state;
  let { artifacts, activeArtifactId } = state;
  for (const raw of delta) {
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as { op?: unknown; path?: unknown; value?: unknown };
    if ((op.op !== 'add' && op.op !== 'replace') || typeof op.path !== 'string') continue;
    if (op.path === '/activeArtifactId') {
      if (typeof op.value === 'string') activeArtifactId = op.value;
      continue;
    }
    const prefix = '/artifacts/';
    if (op.path.startsWith(prefix) && op.value && typeof op.value === 'object') {
      const id = pointerDecode(op.path.slice(prefix.length));
      artifacts = { ...artifacts, [id]: op.value as ArtifactView };
    }
  }
  return { ...state, artifacts, activeArtifactId };
}

function applyStreamEvent(state: StreamUiState, event: StreamEvent): StreamUiState {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return { ...state, running: true, streamingText: null, errorMessage: null };
    case EventType.TEXT_MESSAGE_START:
      return { ...state, streamingText: '' };
    case EventType.TEXT_MESSAGE_CONTENT:
      if (typeof event.delta !== 'string') return state;
      return { ...state, streamingText: (state.streamingText ?? '') + event.delta };
    case EventType.STATE_DELTA:
      return applyStateDelta(state, event.delta);
    case EventType.RUN_FINISHED:
      // 终态清空流式文本：这一轮的定稿以详情接口回拉为真源。
      return { ...state, running: false, streamingText: null };
    case EventType.RUN_ERROR:
      return {
        ...state,
        running: false,
        streamingText: null,
        errorMessage: event.message ?? '这轮生成失败了，请重试。',
      };
    default:
      // TEXT_MESSAGE_END / 心跳外的其他 AG-UI 事件：当前 UI 不消费，原样忽略。
      return state;
  }
}

export function streamUiReducer(state: StreamUiState, action: StreamUiAction): StreamUiState {
  switch (action.kind) {
    case 'stream-event':
      return applyStreamEvent(state, action.event);
    case 'seed-artifacts': {
      // 详情真源覆盖同 id 条目，保留流里已到但详情还没回拉到的新产物。
      const artifacts = { ...state.artifacts };
      for (const a of action.artifacts) artifacts[a.id] = a;
      const fallbackActive = action.artifacts.at(-1)?.id ?? null;
      return {
        ...state,
        artifacts,
        activeArtifactId: state.activeArtifactId ?? fallbackActive,
      };
    }
    case 'select-artifact':
      return { ...state, activeArtifactId: action.id };
    case 'turn-accepted':
      return { ...state, running: true, errorMessage: null };
    case 'error':
      return { ...state, running: false, errorMessage: action.message };
    case 'reset':
      return initialStreamUiState;
  }
}
