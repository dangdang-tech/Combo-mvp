// 契约形态测试夹具（TaskView / CapabilityView + 分页包络），与 @cb/shared schema 对齐。
import type { CapabilityView, PageMeta, TaskView } from '@cb/shared';

export function makeTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task-1',
    currentStep: 'upload',
    status: 'running',
    executionMode: 'cloud',
    retryCount: 0,
    upload: {
      status: 'pending',
      partsExpected: null,
      partsLanded: 0,
      pairingExpiresAt: '2026-07-04T12:00:00.000Z',
    },
    capabilityCount: 0,
    createdAt: '2026-07-04T10:00:00.000Z',
    updatedAt: '2026-07-04T10:00:00.000Z',
    ...overrides,
  };
}

export function makeCapability(overrides: Partial<CapabilityView> = {}): CapabilityView {
  return {
    id: 'cap-1',
    taskId: 'task-1',
    name: '周报整理',
    summary: '把一周的碎片记录整理成结构化周报。',
    kind: 'workflow',
    published: false,
    createdAt: '2026-07-04T11:00:00.000Z',
    ...overrides,
  };
}

export function pageMeta(overrides: Partial<PageMeta> = {}): PageMeta {
  return { nextCursor: null, hasMore: false, limit: 20, order: 'desc', ...overrides };
}

/** 集合成功包络（Paginated<T> 线上形态）。 */
export function paginatedBody<T>(items: T[], meta: Partial<PageMeta> = {}) {
  return { data: items, meta: { traceId: 'trace-list', page: pageMeta(meta) } };
}

/** 单体成功包络。 */
export function envelopeBody<T>(data: T) {
  return { data, meta: { traceId: 'trace-one' } };
}
