// 发布模块出口（F-14）——PRD 2 步坍缩后仅保留「批量发布」复用件：
//   能力页「一键发布」直接调 publishApi.createPublishBatch + 订阅批次 SSE + batchState.mergeBatchState 合并，
//   逐项状态在能力页内联呈现（结构化中/发布中/已提交·Alpha 审核中/失败）。
//   已下线的页面级件（单发布 / 封面 / 定价 / 市集卡预览 / 发布容器 / 批次卡预览）随结构坍缩删除。
export { itemsFromSnapshot, mergeBatchState, type BatchViewState } from './batchState.js';
export {
  publishVersion,
  previewMarketCard,
  createPublishBatch,
  fetchPublishBatch,
  retryBatchItem,
  fetchPublication,
  publishPath,
  previewPath,
  retryItemPath,
} from './publishApi.js';
