// 路由前缀与 SSE 端点路径模板。
export const API_PREFIX = '/api/v1';

/** 基础设施探针，不在 /api/v1 前缀下。 */
export const HEALTH_PATH = '/health';
export const READY_PATH = '/ready';

/** SSE 端点路径模板。 */
export const SSE_ROUTES = {
  /** 任务进度流（上传分片计数 + 提取子任务点亮）。 */
  taskEvents: (taskId: string) => `${API_PREFIX}/tasks/${taskId}/events`,
  /** 试用会话的流式生成事件（断线凭 Last-Event-ID 续传）。 */
  sessionStream: (sessionId: string) => `${API_PREFIX}/runtime/sessions/${sessionId}/stream`,
} as const;
