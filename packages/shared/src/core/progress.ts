// 任务进度模型：总进度 + 子任务清单 + 量化文案。tasks.meta.progress 持久化，
// 同时是 SSE state_snapshot 的全量真源。
import { z } from 'zod';

export const SubtaskStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
export type SubtaskStatus = z.infer<typeof SubtaskStatusSchema>;

export const SubtaskViewSchema = z.object({
  key: z.string(),
  label: z.string().describe('人话子任务名'),
  status: SubtaskStatusSchema,
});
export type SubtaskView = z.infer<typeof SubtaskViewSchema>;

export const ProgressViewSchema = z.object({
  percent: z.number().min(0).max(100).describe('总进度 0-100，单调不倒退'),
  phrase: z.string().describe('量化文案，如「已分析 146 / 215 段会话」'),
  done: z.number().int().optional(),
  total: z.number().int().optional(),
  unit: z.string().optional(),
  subtasks: z.array(SubtaskViewSchema),
  slow: z.boolean().optional(),
});
export type ProgressView = z.infer<typeof ProgressViewSchema>;

/**
 * 提取流水线的子任务标准序（worker 据此初始化 subtasks，前端逐条点亮）。
 * 上传阶段的进度由分片计数表达（已收 N / 共 M 片），不走子任务清单。
 */
export const PIPELINE_SUBTASKS = [
  { key: 'fetch', label: '读取上传内容' },
  { key: 'redact', label: '抹掉隐私信息' },
  { key: 'segment', label: '切分会话段落' },
  { key: 'extract', label: '归纳提炼能力' },
  { key: 'persist', label: '生成能力项' },
] as const;
