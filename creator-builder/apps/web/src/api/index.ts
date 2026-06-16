// API 层出口：typed client + SSE hook（均消费 @cb/shared 契约真源）。
export {
  ApiError,
  apiGet,
  apiGetEnvelope,
  apiPost,
  apiPostReadonly,
  apiPatch,
  apiDelete,
  type RequestOptions,
  type WriteOptions,
  type ReadonlyPostOptions,
  type IdempotencyScopeInput,
  type IdempotencyOptionalScopeInput,
} from './client.js';
export {
  useSSE,
  type UseSSEState,
  type UseSSEOptions,
  type SSEConnectionStatus,
} from './useSSE.js';
