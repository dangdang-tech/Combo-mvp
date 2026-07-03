// 分页：cursor 唯一，不用 offset（脊柱 §2.3）。
import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const PageOrderSchema = z.enum(['asc', 'desc']);
export type PageOrder = z.infer<typeof PageOrderSchema>;

/** 请求侧分页参数。cursor 不透明（服务端 base64 编码 {sortKey,id}）。 */
export const PageQuerySchema = z.object({
  cursor: z.string().optional().describe('不透明游标；首页不传'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT).optional(),
  order: PageOrderSchema.optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** 响应侧 meta.page。不返回 total（脊柱 §2.3）。 */
export const PageMetaSchema = z.object({
  nextCursor: z.string().nullable().describe('null = 到底'),
  hasMore: z.boolean(),
  limit: z.number().int(),
  order: PageOrderSchema,
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

// ===========================================================================
// 不透明 cursor 编解码（脊柱 §2.3：cursor 不透明，服务端 base64 编码 {id,...}）。
//   统一编码器：把内部锚（sortKey/id）编成对前端不透明的串；解码失败 → 抛 InvalidCursorError，
//   handler 映射 400 VALIDATION_FAILED（action:change_input，对外信封无 code）。
//   契约要求（60 §2.7 / §1.6）：cursor 失效/格式非法 → 400（非静默回首页、非 500）。
// ===========================================================================

/** cursor 解码失败（不存在键/格式非法/被改写）。handler 据此回 400 VALIDATION_FAILED。 */
export class InvalidCursorError extends Error {
  constructor(message = 'invalid cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** cursor 不透明前缀标记（解码时校验，防把任意串当 cursor 静默吞）。 */
const CURSOR_MAGIC = 'cb1';

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function fromBase64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

/**
 * 编码不透明 cursor（payload 为内部锚对象，如 {id} 或 {sortKey,id}）。
 *   产物形如 `cb1.<base64url(json)>`，对前端不透明、可双向校验。
 */
export function encodeCursor(payload: Record<string, unknown>): string {
  return `${CURSOR_MAGIC}.${toBase64Url(JSON.stringify(payload))}`;
}

/**
 * 解码不透明 cursor → 内部锚对象。
 *   前缀/分隔/base64/json 任一非法 → 抛 {@link InvalidCursorError}（handler 回 400，不静默回首页）。
 */
export function decodeCursor<T extends Record<string, unknown> = Record<string, unknown>>(
  cursor: string,
): T {
  const dot = cursor.indexOf('.');
  if (dot < 0 || cursor.slice(0, dot) !== CURSOR_MAGIC) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(cursor.slice(dot + 1)));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursorError();
  return parsed as T;
}

/** 单 id 锚的便捷编码（绝大多数列表端点：cursor = 上一页末位 id）。 */
export function encodeIdCursor(id: string): string {
  return encodeCursor({ id });
}

/**
 * 单 id 锚的便捷解码。校验 payload.id 为非空字符串，否则抛 InvalidCursorError。
 *   注意：id 仅做形态校验；「id 不在当前结果集」由调用方解释（位置锚回 400 / 比较锚自然空页，按端点语义）。
 */
export function decodeIdCursor(cursor: string): string {
  const { id } = decodeCursor<{ id?: unknown }>(cursor);
  if (typeof id !== 'string' || id.length === 0) throw new InvalidCursorError();
  return id;
}
