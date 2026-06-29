// 路由前缀与版本（脊柱 §1.1）。SSE 端点路径模板（§5.1）。
export const API_PREFIX = '/api/v1';

/** 基础设施探针，不在 /api/v1 前缀下（脊柱 §10.1）。 */
export const HEALTH_PATH = '/health';
export const READY_PATH = '/ready';

/** SSE 端点路径模板（脊柱 §5.1 / §2.8）。本期可调用两个。 */
export const SSE_ROUTES = {
  /** kind=job：导入/提取/批量发布复用。 */
  jobEvents: (jobId: string) => `${API_PREFIX}/jobs/${jobId}/events`,
  /** kind=structure：结构化字段流。 */
  structureEvents: (versionId: string) => `${API_PREFIX}/versions/${versionId}/structure/events`,
} as const;
