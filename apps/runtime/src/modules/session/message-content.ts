// messages.content 的严格 schema（写入前必过）：对齐 pi 包的 AgentMessage content 类型。
//   - user：TextContent | ImageContent 块数组（pi UserMessage.content 的数组形态）。
//   - assistant：TextContent | ThinkingContent | ToolCall 块数组（pi AssistantMessage.content）。
//   - tool：本模块定义的 toolResult 包装块（pi 无独立 tool-result 块类型；块内字段与
//     pi ToolResultMessage 对齐——toolCallId/toolName/content/isError 缺一不可，否则喂回
//     agent 时 toolCall/toolResult 配对丢失，历史重建即失真）。
//   块用 passthrough：pi 会在块上追加签名类元数据（textSignature 等），原样保留保证往返无损。
import { z } from 'zod';
import type { MessageRole } from '@cb/shared';

export const TextContentSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .passthrough();

export const ImageContentSchema = z
  .object({ type: z.literal('image'), data: z.string(), mimeType: z.string() })
  .passthrough();

export const ThinkingContentSchema = z
  .object({ type: z.literal('thinking'), thinking: z.string() })
  .passthrough();

export const ToolCallContentSchema = z
  .object({
    type: z.literal('toolCall'),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const ToolResultBlockSchema = z
  .object({
    type: z.literal('toolResult'),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.discriminatedUnion('type', [TextContentSchema, ImageContentSchema])),
    isError: z.boolean(),
  })
  .passthrough();

const CONTENT_SCHEMA_BY_ROLE: Record<MessageRole, z.ZodTypeAny> = {
  user: z.array(z.discriminatedUnion('type', [TextContentSchema, ImageContentSchema])).min(1),
  assistant: z
    .array(
      z.discriminatedUnion('type', [
        TextContentSchema,
        ThinkingContentSchema,
        ToolCallContentSchema,
      ]),
    )
    .min(1),
  tool: z.array(ToolResultBlockSchema).min(1),
};

/** content 校验失败的类型化错误（repo 抛出，handler 收口成 VALIDATION_FAILED / INTERNAL）。 */
export class InvalidMessageContentError extends Error {
  constructor(role: MessageRole, detail: string) {
    super(`messages.content 不符合 ${role} 角色的块结构：${detail}`);
    this.name = 'InvalidMessageContentError';
  }
}

/** 按角色严格校验 content 块数组；坏块拒写（抛 InvalidMessageContentError）。 */
export function parseMessageContent(role: MessageRole, content: unknown): unknown[] {
  const parsed = CONTENT_SCHEMA_BY_ROLE[role].safeParse(content);
  if (!parsed.success) {
    throw new InvalidMessageContentError(role, parsed.error.issues[0]?.message ?? 'unknown');
  }
  return parsed.data as unknown[];
}
