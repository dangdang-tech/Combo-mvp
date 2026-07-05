// API 层出口：typed client + 业务端点 + 任务进度 SSE hook（均消费 @cb/shared 契约真源）。
export {
  ApiError,
  apiGet,
  apiGetEnvelope,
  apiPost,
  fallbackErrorBody,
  sanitizeErrorBody,
  unwrapErrorBody,
  type RequestOptions,
} from './client.js';
export * from './endpoints.js';
export {
  useTaskEvents,
  reduceTaskEvents,
  INITIAL_TASK_EVENTS_STATE,
  __setFetchEventSourceForTests,
  type TaskEventsState,
  type SSEConnectionStatus,
  type UseTaskEventsOptions,
} from './useTaskEvents.js';
