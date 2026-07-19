import { z } from 'zod';

/** 白名单节点类型清单：渲染器只认识这 12 种节点，顺序与 JSON Schema 中的 oneOf 一致。 */
export const NODE_TYPES = [
  'stack',
  'heading',
  'text',
  'markdown',
  'card',
  'list-item',
  'badge',
  'button',
  'citation',
  'empty-state',
  'timestamp',
  'skeleton',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/** 节点树允许的最大嵌套深度（根节点算第 1 层）。 */
export const MAX_DEPTH = 6;

/** 单个文档允许的最大节点总数。 */
export const MAX_NODES = 200;

export type StackGap = 'sm' | 'md' | 'lg';
export type StackDirection = 'column' | 'row';
export type HeadingLevel = 1 | 2 | 3 | 4;
export type TextVariant = 'body' | 'muted' | 'caption' | 'label';
export type CardVariant = 'surface' | 'raised' | 'hero';
export type CardPadding = 'none' | 'md' | 'lg';
export type BadgeVariant = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type TimestampMode = 'absolute' | 'relative';
export type SkeletonVariant = 'text' | 'block' | 'circle';

/** 徽标内容：list-item 的 badge 字段与独立 badge 节点共用同一结构。 */
export interface BadgeContent {
  variant?: BadgeVariant;
  text: string;
}

export interface StackNode {
  type: 'stack';
  gap?: StackGap;
  direction?: StackDirection;
  children: MiniAppNode[];
}

export interface HeadingNode {
  type: 'heading';
  level: HeadingLevel;
  text: string;
}

export interface TextNode {
  type: 'text';
  variant?: TextVariant;
  text: string;
}

export interface MarkdownNode {
  type: 'markdown';
  content: string;
}

export interface CardNode {
  type: 'card';
  variant?: CardVariant;
  padding?: CardPadding;
  children: MiniAppNode[];
}

export interface ListItemNode {
  type: 'list-item';
  title: string;
  description?: string;
  badge?: BadgeContent;
}

export interface BadgeNode extends BadgeContent {
  type: 'badge';
}

export interface ButtonNode {
  type: 'button';
  variant?: ButtonVariant;
  size?: ButtonSize;
  text: string;
  /** 动作只带标识符，具体行为由宿主（onAction 回调）决定，渲染器不执行任何代码。 */
  actionId: string;
}

export interface CitationNode {
  type: 'citation';
  label: string;
  href?: string;
  quote?: string;
  index?: number;
}

export interface EmptyStateNode {
  type: 'empty-state';
  title: string;
  description?: string;
}

export interface TimestampNode {
  type: 'timestamp';
  /** ISO 8601 时间字符串。 */
  value: string;
  mode?: TimestampMode;
}

export interface SkeletonNode {
  type: 'skeleton';
  variant?: SkeletonVariant;
}

export type MiniAppNode =
  | StackNode
  | HeadingNode
  | TextNode
  | MarkdownNode
  | CardNode
  | ListItemNode
  | BadgeNode
  | ButtonNode
  | CitationNode
  | EmptyStateNode
  | TimestampNode
  | SkeletonNode;

/** 顶层文档：version 固定为 1，root 是白名单节点树。 */
export interface MiniAppDocument {
  version: 1;
  root: MiniAppNode;
}

const badgeVariantSchema = z.enum(['neutral', 'ok', 'warn', 'danger', 'accent']);

const badgeContentSchema = z.object({
  variant: badgeVariantSchema.optional(),
  text: z.string(),
});

/**
 * 单个节点的 zod schema：以 type 字段做判别的 12 种白名单节点联合。
 * 递归引用经 z.lazy 延迟求值，未知 type 一律校验失败。
 */
export const nodeSchema: z.ZodType<MiniAppNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    stackSchema,
    headingSchema,
    textSchema,
    markdownSchema,
    cardSchema,
    listItemSchema,
    badgeSchema,
    buttonSchema,
    citationSchema,
    emptyStateSchema,
    timestampSchema,
    skeletonSchema,
  ]),
);

const stackSchema = z.object({
  type: z.literal('stack'),
  gap: z.enum(['sm', 'md', 'lg']).optional(),
  direction: z.enum(['column', 'row']).optional(),
  children: z.array(nodeSchema),
});

const headingSchema = z.object({
  type: z.literal('heading'),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  text: z.string(),
});

const textSchema = z.object({
  type: z.literal('text'),
  variant: z.enum(['body', 'muted', 'caption', 'label']).optional(),
  text: z.string(),
});

const markdownSchema = z.object({
  type: z.literal('markdown'),
  content: z.string(),
});

const cardSchema = z.object({
  type: z.literal('card'),
  variant: z.enum(['surface', 'raised', 'hero']).optional(),
  padding: z.enum(['none', 'md', 'lg']).optional(),
  children: z.array(nodeSchema),
});

const listItemSchema = z.object({
  type: z.literal('list-item'),
  title: z.string(),
  description: z.string().optional(),
  badge: badgeContentSchema.optional(),
});

const badgeSchema = z.object({
  type: z.literal('badge'),
  variant: badgeVariantSchema.optional(),
  text: z.string(),
});

const buttonSchema = z.object({
  type: z.literal('button'),
  variant: z.enum(['primary', 'secondary', 'ghost', 'danger']).optional(),
  size: z.enum(['sm', 'md', 'lg']).optional(),
  text: z.string(),
  actionId: z.string().min(1),
});

const safeHrefSchema = z
  .string()
  .refine(
    (v) => /^https?:\/\//i.test(v) || v.startsWith('/') || v.startsWith('#') || v.startsWith('./'),
    { message: 'href 只允许 http(s) 绝对地址或站内相对路径（禁止 javascript: 等伪协议）' },
  );

const citationSchema = z.object({
  type: z.literal('citation'),
  label: z.string(),
  href: safeHrefSchema.optional(),
  quote: z.string().optional(),
  index: z.number().int().min(1).optional(),
});

const emptyStateSchema = z.object({
  type: z.literal('empty-state'),
  title: z.string(),
  description: z.string().optional(),
});

const timestampSchema = z.object({
  type: z.literal('timestamp'),
  value: z.string(),
  mode: z.enum(['absolute', 'relative']).optional(),
});

const skeletonSchema = z.object({
  type: z.literal('skeleton'),
  variant: z.enum(['text', 'block', 'circle']).optional(),
});

/** 统计一棵节点树的节点总数与最大嵌套深度（根节点深度为 1）。 */
function measureTree(node: MiniAppNode): { count: number; depth: number } {
  const children = 'children' in node ? node.children : [];
  let count = 1;
  let maxChildDepth = 0;
  for (const child of children) {
    const measured = measureTree(child);
    count += measured.count;
    if (measured.depth > maxChildDepth) {
      maxChildDepth = measured.depth;
    }
  }
  return { count, depth: 1 + maxChildDepth };
}

/**
 * 顶层文档 schema：{ version: 1, root: Node }。
 * superRefine 追加两条整体约束：嵌套深度不超过 MAX_DEPTH，节点总数不超过 MAX_NODES。
 */
export const miniAppDocumentSchema: z.ZodType<MiniAppDocument> = z
  .object({
    version: z.literal(1),
    root: nodeSchema,
  })
  .superRefine((doc, ctx) => {
    const { count, depth } = measureTree(doc.root);
    if (depth > MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['root'],
        message: `节点嵌套深度 ${depth} 超过上限 ${MAX_DEPTH}`,
      });
    }
    if (count > MAX_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['root'],
        message: `节点总数 ${count} 超过上限 ${MAX_NODES}`,
      });
    }
  });
