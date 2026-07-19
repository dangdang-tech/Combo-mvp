import { type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Citation,
  EmptyState,
  Heading,
  ListItem,
  Markdown,
  MiniAppShell,
  Skeleton,
  Text,
  Timestamp,
} from '@cb/ds';
import { type ZodIssue } from 'zod';
import { miniAppDocumentSchema, type MiniAppNode, type StackGap } from './schema';

/** stack 的 gap 档位到间距 token 的映射，间距值一律引用 --cb-space-* 变量。 */
const STACK_GAP_VAR: Record<StackGap, string> = {
  sm: 'var(--cb-space-2)',
  md: 'var(--cb-space-4)',
  lg: 'var(--cb-space-5)',
};

export interface MiniAppRendererProps {
  /** 待渲染的 mini-app UI 文档，类型故意收窄为 unknown：一切输入先过 zod 校验。 */
  document: unknown;
  /** 可选的经验体标题：提供后整体包在 @cb/ds 的 MiniAppShell 外壳里。 */
  title?: string;
  /** 可选的动作回调：button 节点被点击时收到其 actionId，具体行为由宿主决定。 */
  onAction?: (actionId: string) => void;
}

function renderNode(
  node: MiniAppNode,
  key: string | number,
  onAction?: (actionId: string) => void,
): ReactNode {
  switch (node.type) {
    case 'stack': {
      const direction = node.direction ?? 'column';
      return (
        <div
          key={key}
          className="cb-ma-stack"
          style={{
            display: 'flex',
            flexDirection: direction,
            alignItems: direction === 'row' ? 'center' : 'stretch',
            flexWrap: direction === 'row' ? 'wrap' : undefined,
            gap: STACK_GAP_VAR[node.gap ?? 'md'],
          }}
        >
          {node.children.map((child, i) => renderNode(child, i, onAction))}
        </div>
      );
    }
    case 'heading':
      return (
        <Heading key={key} level={node.level}>
          {node.text}
        </Heading>
      );
    case 'text':
      return (
        <Text key={key} variant={node.variant}>
          {node.text}
        </Text>
      );
    case 'markdown':
      return <Markdown key={key} content={node.content} />;
    case 'card':
      return (
        <Card key={key} variant={node.variant} padding={node.padding}>
          {node.children.map((child, i) => renderNode(child, i, onAction))}
        </Card>
      );
    case 'list-item':
      return (
        <ListItem
          key={key}
          title={node.title}
          description={node.description}
          trailing={
            node.badge !== undefined ? (
              <Badge variant={node.badge.variant}>{node.badge.text}</Badge>
            ) : undefined
          }
        />
      );
    case 'badge':
      return (
        <Badge key={key} variant={node.variant}>
          {node.text}
        </Badge>
      );
    case 'button':
      return (
        <Button
          key={key}
          variant={node.variant}
          size={node.size}
          onClick={onAction !== undefined ? () => onAction(node.actionId) : undefined}
        >
          {node.text}
        </Button>
      );
    case 'citation':
      return (
        <Citation
          key={key}
          label={node.label}
          href={node.href}
          quote={node.quote}
          index={node.index}
        />
      );
    case 'empty-state':
      return <EmptyState key={key} title={node.title} description={node.description} />;
    case 'timestamp':
      return <Timestamp key={key} value={node.value} mode={node.mode} />;
    case 'skeleton':
      return <Skeleton key={key} variant={node.variant} />;
  }
}

/** zod 校验失败时的降级错误卡片：列出前几条 issue，绝不抛异常。 */
function FallbackErrorCard({ issues }: { issues: ZodIssue[] }) {
  const shown = issues.slice(0, 5);
  const hidden = issues.length - shown.length;
  return (
    <Card variant="surface" padding="lg">
      <div
        className="cb-ma-stack"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cb-space-3)' }}
      >
        <div
          className="cb-ma-stack"
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 'var(--cb-space-2)',
          }}
        >
          <Badge variant="danger">渲染失败</Badge>
          <Text variant="label" as="span">
            invalid mini-app document
          </Text>
        </div>
        <Text>经验体渲染失败：输出不符合 mini-app UI 白名单结构，已降级为本提示卡片。</Text>
        {shown.map((issue, i) => (
          <Text key={i} variant="caption">
            {issue.path.length > 0 ? issue.path.join('.') : '(根节点)'}：{issue.message}
          </Text>
        ))}
        {hidden > 0 ? <Text variant="muted">另有 {hidden} 条校验问题未展示。</Text> : null}
      </div>
    </Card>
  );
}

/**
 * 经验体 mini-app 受限渲染器：输入 unknown 文档，先经 zod safeParse 白名单校验，
 * 校验通过则把节点树递归映射为 @cb/ds 组件，失败则渲染降级错误卡片，任何输入都不抛异常。
 */
export function MiniAppRenderer({ document, title, onAction }: MiniAppRendererProps) {
  const parsed = miniAppDocumentSchema.safeParse(document);
  const body = parsed.success ? (
    renderNode(parsed.data.root, 'root', onAction)
  ) : (
    <FallbackErrorCard issues={parsed.error.issues} />
  );
  if (title !== undefined) {
    return (
      <MiniAppShell title={title} status={parsed.success ? 'ok' : 'error'}>
        {body}
      </MiniAppShell>
    );
  }
  return <>{body}</>;
}
