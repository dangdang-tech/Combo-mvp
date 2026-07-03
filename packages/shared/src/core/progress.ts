// progress 模型（脊柱 §7）：总进度 + 子任务清单 + 量化文案 + 边生成边显示。
// jobs.progress 持久化 + 作为 state_snapshot(job) 全量真源。
import { z } from 'zod';

export const SubtaskStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
export type SubtaskStatus = z.infer<typeof SubtaskStatusSchema>;

export const SubtaskViewSchema = z.object({
  key: z.string(),
  label: z.string().describe('人话子任务名'),
  status: SubtaskStatusSchema,
});
export type SubtaskView = z.infer<typeof SubtaskViewSchema>;

export const ProgressMetricsSchema = z.object({
  analyzedSegments: z.number().int().nonnegative().optional(),
  discoveredCandidates: z.number().int().nonnegative().optional(),
});
export type ProgressMetrics = z.infer<typeof ProgressMetricsSchema>;

export const ProgressViewSchema = z.object({
  percent: z.number().min(0).max(100).describe('总进度 0-100，单调不倒退'),
  phrase: z.string().describe('量化文案，如「68% · 已抓取 146 / 215 段会话」'),
  done: z.number().int().optional(),
  total: z.number().int().optional(),
  unit: z.string().optional(),
  metrics: ProgressMetricsSchema.optional().describe('领域指标扩展，供加载态展示多个计数'),
  subtasks: z.array(SubtaskViewSchema),
  items: z.array(z.unknown()).optional().describe('边生成边显示已追加项摘要'),
  slow: z.boolean().optional(),
});
export type ProgressView = z.infer<typeof ProgressViewSchema>;

/**
 * 子任务标准序（脊柱 §7，验收逐条点亮）。各域 worker 据此初始化 subtasks，前端据此渲染。
 * 结构化以字段流 + structure_state 表达，subtasks 仅表「正在补全字段 N/M」类进度。
 */
export const SUBTASK_SEQUENCES = {
  import: [
    { key: 'credential', label: '连接凭证' },
    { key: 'fetch_index', label: '拉取会话索引' },
    { key: 'redact', label: '导入消息并抹掉隐私信息' },
    { key: 'segment', label: '切分成段落' },
    { key: 'snapshot', label: '生成原始数据' },
  ],
  extract: [
    { key: 'analyze', label: '分析会话段落' },
    { key: 'cluster', label: '聚类相似工作流' },
    { key: 'form', label: '形成候选能力' },
    { key: 'score', label: '评估频率与可打包度' },
    { key: 'rank', label: '按成功率排序' },
  ],
} as const satisfies Record<string, ReadonlyArray<{ key: string; label: string }>>;
