import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MiniAppRenderer } from './renderer';
import { MAX_DEPTH, MAX_NODES, miniAppDocumentSchema, NODE_TYPES } from './schema';

// vitest 未开 globals，@testing-library/react 的自动清理不会生效，这里显式在每个用例后卸载 DOM。
afterEach(cleanup);

function readPackageFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function loadExample(name: string): unknown {
  return JSON.parse(readPackageFile(`../examples/${name}`)) as unknown;
}

/** 递归收集任意 JSON 值里所有 "type" 键对应的字符串值。 */
function collectTypeValues(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTypeValues(item, out);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'type' && typeof child === 'string') {
        out.add(child);
      }
      collectTypeValues(child, out);
    }
  }
}

/** 构造嵌套 depth 层 stack 的文档（depth 含最内层的 text 节点）。 */
function buildNestedDocument(depth: number): unknown {
  let node: unknown = { type: 'text', text: '最内层' };
  for (let i = 1; i < depth; i += 1) {
    node = { type: 'stack', children: [node] };
  }
  return { version: 1, root: node };
}

const EXAMPLE_FILES = ['ctr-review.json', 'daily-brief.json'];

describe('examples 与 schema 一致性', () => {
  it.each(EXAMPLE_FILES)('%s 通过 zod 校验', (file) => {
    const parsed = miniAppDocumentSchema.safeParse(loadExample(file));
    expect(parsed.success).toBe(true);
  });

  it.each(EXAMPLE_FILES)('%s 中出现的 type 值全部在白名单内', (file) => {
    const types = new Set<string>();
    collectTypeValues(loadExample(file), types);
    expect(types.size).toBeGreaterThan(0);
    for (const type of types) {
      expect(NODE_TYPES).toContain(type);
    }
  });

  it('JSON Schema 里枚举的节点 type 白名单与 zod 的 NODE_TYPES 完全一致', () => {
    interface SchemaNodeDefinition {
      properties?: { type?: { const?: unknown } };
    }
    interface SchemaDocument {
      definitions?: Record<string, SchemaNodeDefinition>;
    }
    const schemaDoc = JSON.parse(
      readPackageFile('../schema/miniapp-ui.schema.json'),
    ) as SchemaDocument;
    const schemaTypes: string[] = [];
    for (const definition of Object.values(schemaDoc.definitions ?? {})) {
      const typeConst = definition.properties?.type?.const;
      if (typeof typeConst === 'string') {
        schemaTypes.push(typeConst);
      }
    }
    expect(new Set(schemaTypes)).toEqual(new Set(NODE_TYPES));
    expect(schemaTypes).toHaveLength(NODE_TYPES.length);
  });
});

describe('合法文档渲染', () => {
  it('渲染 ctr-review 示例的关键内容', () => {
    render(<MiniAppRenderer document={loadExample('ctr-review.json')} />);
    expect(screen.getByRole('heading', { name: '女装主推款 CTR 判断' })).toBeInTheDocument();
    expect(screen.getByText('候选 A：法式方领连衣裙')).toBeInTheDocument();
    expect(screen.getByText('主推')).toBeInTheDocument();
    expect(screen.getByText('2026-06-24 投放复盘会话')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '用最新数据复跑判断' })).toBeInTheDocument();
    expect(screen.queryByText(/经验体渲染失败/)).not.toBeInTheDocument();
  });

  it('渲染 daily-brief 示例的关键内容', () => {
    render(<MiniAppRenderer document={loadExample('daily-brief.json')} />);
    expect(screen.getByRole('heading', { name: '每日情报简报' })).toBeInTheDocument();
    expect(screen.getByText('3 条新情报')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成明日简报' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '情报源：女装品类日报 2026-07-07' })).toHaveAttribute(
      'href',
      'https://example.com/brief/2026-07-07',
    );
  });

  it('12 种白名单节点全部可渲染', () => {
    const doc = {
      version: 1,
      root: {
        type: 'stack',
        gap: 'sm',
        children: [
          { type: 'heading', level: 3, text: '全节点覆盖' },
          { type: 'text', variant: 'caption', text: '一段说明文字' },
          { type: 'markdown', content: '**加粗** 内容' },
          {
            type: 'card',
            variant: 'raised',
            padding: 'lg',
            children: [
              { type: 'list-item', title: '行标题', description: '行描述', badge: { text: '徽' } },
            ],
          },
          { type: 'badge', variant: 'accent', text: '独立徽标' },
          { type: 'button', variant: 'ghost', size: 'sm', text: '按一下', actionId: 'noop' },
          { type: 'citation', label: '来源', quote: '原文片段', index: 2 },
          { type: 'empty-state', title: '空空如也', description: '还没有数据' },
          { type: 'timestamp', value: '2026-07-07T08:00:00+08:00', mode: 'absolute' },
          { type: 'skeleton', variant: 'circle' },
        ],
      },
    };
    const { container } = render(<MiniAppRenderer document={doc} />);
    expect(screen.getByRole('heading', { name: '全节点覆盖' })).toBeInTheDocument();
    expect(screen.getByText('行标题')).toBeInTheDocument();
    expect(screen.getByText('空空如也')).toBeInTheDocument();
    expect(container.querySelector('.cb-skeleton')).not.toBeNull();
    expect(container.querySelector('.cb-markdown strong')).not.toBeNull();
    expect(screen.queryByText(/经验体渲染失败/)).not.toBeInTheDocument();
  });

  it('传入 title 时包在 MiniAppShell 外壳里并显示 ok 状态', () => {
    const { container } = render(
      <MiniAppRenderer document={loadExample('daily-brief.json')} title="每日简报经验体" />,
    );
    expect(screen.getByText('每日简报经验体')).toBeInTheDocument();
    expect(container.querySelector('.cb-mini-app-shell-status--ok')).not.toBeNull();
  });
});

describe('非法输入降级', () => {
  it('垃圾对象不抛异常并渲染降级错误卡片', () => {
    expect(() => {
      render(<MiniAppRenderer document={{ hello: 'world' }} />);
    }).not.toThrow();
    expect(screen.getByText(/经验体渲染失败/)).toBeInTheDocument();
    expect(screen.getByText('渲染失败')).toBeInTheDocument();
  });

  it('null、字符串等非对象输入同样降级', () => {
    const { unmount } = render(<MiniAppRenderer document={null} />);
    expect(screen.getByText(/经验体渲染失败/)).toBeInTheDocument();
    unmount();
    render(<MiniAppRenderer document="not a document" />);
    expect(screen.getByText(/经验体渲染失败/)).toBeInTheDocument();
  });

  it('未知节点 type 降级', () => {
    const doc = {
      version: 1,
      root: { type: 'iframe', src: 'https://evil.example.com' },
    };
    render(<MiniAppRenderer document={doc} />);
    expect(screen.getByText(/经验体渲染失败/)).toBeInTheDocument();
  });

  it(`嵌套深度超过 ${MAX_DEPTH} 层降级`, () => {
    expect(miniAppDocumentSchema.safeParse(buildNestedDocument(MAX_DEPTH)).success).toBe(true);
    render(<MiniAppRenderer document={buildNestedDocument(MAX_DEPTH + 2)} />);
    expect(screen.getByText(/经验体渲染失败/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`超过上限 ${MAX_DEPTH}`))).toBeInTheDocument();
  });

  it(`节点总数超过 ${MAX_NODES} 降级`, () => {
    const children = Array.from({ length: MAX_NODES }, (_, i) => ({
      type: 'text',
      text: `第 ${i} 条`,
    }));
    render(<MiniAppRenderer document={{ version: 1, root: { type: 'stack', children } }} />);
    expect(screen.getByText(/经验体渲染失败/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`超过上限 ${MAX_NODES}`))).toBeInTheDocument();
  });

  it('非法输入配合 title 时外壳显示 error 状态', () => {
    const { container } = render(<MiniAppRenderer document={42} title="坏掉的经验体" />);
    expect(container.querySelector('.cb-mini-app-shell-status--error')).not.toBeNull();
    expect(screen.getByText(/经验体渲染失败/)).toBeInTheDocument();
  });
});

describe('button 动作回调', () => {
  it('点击 button 节点时以 actionId 调用 onAction', () => {
    const onAction = vi.fn();
    render(<MiniAppRenderer document={loadExample('ctr-review.json')} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '用最新数据复跑判断' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('rerun-ctr-review');
  });

  it('不传 onAction 时点击按钮不抛异常', () => {
    render(<MiniAppRenderer document={loadExample('ctr-review.json')} />);
    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: '用最新数据复跑判断' }));
    }).not.toThrow();
  });
});

describe('注入面收敛', () => {
  it('渲染器源码不直接使用 dangerouslySetInnerHTML（markdown 走 @cb/ds 的 sanitize）', () => {
    const source = readPackageFile('./renderer.tsx');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });

  it('markdown 节点里的 script 会被 sanitize 剥除', () => {
    const doc = {
      version: 1,
      root: {
        type: 'markdown',
        content:
          '正常段落<script>window.__pwned = true;</script><img src="x" onerror="window.__pwned = true;" />',
      },
    };
    const { container } = render(<MiniAppRenderer document={doc} />);
    expect(container.querySelector('script')).toBeNull();
    const img = container.querySelector('img');
    if (img !== null) {
      expect(img.getAttribute('onerror')).toBeNull();
    }
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('text 节点里的 HTML 只会按字面文本渲染', () => {
    const doc = {
      version: 1,
      root: { type: 'text', text: '<b>不是加粗</b>' },
    };
    const { container } = render(<MiniAppRenderer document={doc} />);
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<b>不是加粗</b>')).toBeInTheDocument();
  });
});

describe('citation href 安全约束', () => {
  it('拒绝 javascript: 伪协议 href', () => {
    const doc = {
      version: 1,
      root: { type: 'citation', label: '来源', href: 'javascript:alert(1)' },
    };
    expect(miniAppDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('接受 http(s) 与站内相对路径', () => {
    for (const href of ['https://example.com/a', '/sessions/1', '#ref-2', './detail']) {
      const doc = { version: 1, root: { type: 'citation', label: '来源', href } };
      expect(miniAppDocumentSchema.safeParse(doc).success, `href ${href} 应当合法`).toBe(true);
    }
  });
});
