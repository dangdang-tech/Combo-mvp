// 任务域：一次上传任务的对外形态。状态是两个正交的轴（step + status），
// 提取成功即终态；「发布」不在任务轴上（是能力项上的标记，见 capability.ts）。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';
import { ErrorBodySchema } from '../core/errors.js';

export const TaskStepSchema = z.enum(['upload', 'extract']);
export type TaskStep = z.infer<typeof TaskStepSchema>;

export const TaskStatusSchema = z.enum(['running', 'succeeded', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// expired = 配对窗口结束且清单未收齐；原始分片清理进度另由 raw_purged_at 持久追踪。
export const UploadStatusSchema = z.enum(['pending', 'raw', 'processed', 'expired']);
export type UploadStatus = z.infer<typeof UploadStatusSchema>;

// ---------- 请求 ----------
export const CreateTaskBodySchema = z
  .object({
    idempotencyKey: z.string().min(8).max(128).describe('客户端生成，双击/重试不建出第二个任务'),
    description: z.string().max(500).optional(),
  })
  .strict();
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;

// ---------- 视图 ----------
/** 上传阶段的对外状态（分片计数来自 uploads.parts 登记表）。 */
export const UploadViewSchema = z.object({
  status: UploadStatusSchema,
  partsExpected: z.number().int().nullable().describe('助手声明的分片总数，未声明前为 null'),
  partsLanded: z.number().int().describe('已落地分片数'),
  pairingExpiresAt: IsoDateTimeSchema,
});
export type UploadView = z.infer<typeof UploadViewSchema>;

export const TaskViewSchema = z.object({
  id: IdSchema,
  currentStep: TaskStepSchema,
  status: TaskStatusSchema,
  description: z.string().optional(),
  retryCount: z.number().int(),
  lastError: ErrorBodySchema.optional().describe('最后一次失败的人话错误（失败态才有）'),
  upload: UploadViewSchema,
  capabilityCount: z.number().int().describe('已提取出的能力项数'),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** 建任务的响应：配对码只在这里明文出现一次（库里只存哈希）。 */
export const CreateTaskResultSchema = z.object({
  task: TaskViewSchema,
  pairingCode: z.string().describe('给本机助手用的配对码，仅此一次明文下发'),
});
export type CreateTaskResult = z.infer<typeof CreateTaskResultSchema>;

// ---------- 助手上传（配对路径，唯一上传路径）----------
export const UploadBundleIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ConnectPrepareBodySchema = z
  .object({
    pairingCode: z.string().min(1),
    protocolVersion: z.literal(2),
    bundleId: UploadBundleIdSchema,
    totalParts: z.number().int().min(1).max(10_000),
    replaceExisting: z.boolean().default(false),
  })
  .strict();
export type ConnectPrepareBody = z.infer<typeof ConnectPrepareBodySchema>;

export const ConnectPrepareResultSchema = z.object({
  protocolVersion: z.literal(2),
  bundleId: UploadBundleIdSchema,
  totalParts: z.number().int().min(1),
  landedParts: z.array(z.number().int().min(0)),
  complete: z.boolean(),
});
export type ConnectPrepareResult = z.infer<typeof ConnectPrepareResultSchema>;

/**
 * 助手每传一个分片调一次 POST /connect/upload。首个分片必须带 totalParts 声明总数，
 * 服务端以此对账「收齐没有」；全部收齐自动流转提取。
 */
export const ConnectUploadBodySchema = z.object({
  pairingCode: z.string().min(1),
  /** v2 助手必传；省略仅用于兼容已在运行的 legacy 脚本。 */
  bundleId: UploadBundleIdSchema.optional(),
  partIndex: z.number().int().min(0),
  totalParts: z.number().int().min(1).max(10_000),
  /** 分片内容，utf-8 文本（聊天记录导出格式）。 */
  content: z.string().min(1),
});
export type ConnectUploadBody = z.infer<typeof ConnectUploadBodySchema>;

export const ConnectUploadResultSchema = z.object({
  landed: z.number().int(),
  total: z.number().int(),
  complete: z.boolean().describe('true = 已收齐，提取已自动开始'),
});
export type ConnectUploadResult = z.infer<typeof ConnectUploadResultSchema>;
