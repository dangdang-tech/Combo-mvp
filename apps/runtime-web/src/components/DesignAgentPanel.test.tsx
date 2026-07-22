import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesignAgentPanel, type DesignAgentPanelProps } from './DesignAgentPanel.js';

const resultElement = {
  key: 'result-main',
  label: '今日安排结果',
  role: 'region',
  text: '3 项任务已经排好',
  tagName: 'section',
};

function props(overrides: Partial<DesignAgentPanelProps> = {}): DesignAgentPanelProps {
  return {
    messages: [],
    revisions: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        revisionNo: 1,
        artifactKey: 'main',
        artifactVersion: 1,
        sourceRunId: '22222222-2222-4222-8222-222222222222',
        summary: '生成首版',
        createdAt: '2026-07-21T10:00:00.000Z',
        verified: false,
      },
    ],
    selectedRevisionNo: 1,
    isRunning: false,
    isBootstrapping: false,
    readOnlyHistory: false,
    annotationAvailable: true,
    annotationEnabled: false,
    selectedElement: null,
    error: null,
    onSend: vi.fn(() => true),
    onInterrupt: vi.fn(),
    onSelectRevision: vi.fn(),
    onOpenArtifact: vi.fn(),
    onToggleAnnotation: vi.fn(),
    onClearAnnotation: vi.fn(),
    ...overrides,
  };
}

describe('DesignAgentPanel', () => {
  it('keeps the complete conversation available as one continuous history', () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `message-${index}`,
      runId: null,
      seq: index,
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `第 ${index + 1} 条对话`,
      artifacts: [],
      createdAt: `2026-07-21T10:0${index}:00.000Z`,
    }));
    render(<DesignAgentPanel {...props({ messages })} />);

    expect(screen.getByText('第 1 条对话')).toBeInTheDocument();
    expect(screen.getByText('第 6 条对话')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /更早/ })).not.toBeInTheDocument();
  });

  it('sends a typed edit with Enter', () => {
    const onSend = vi.fn(() => true);
    render(<DesignAgentPanel {...props({ onSend })} />);

    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '统一色彩、间距和圆角' } });

    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('统一色彩、间距和圆角');
  });

  it('keeps a historical page read-only without repeating the global return action', () => {
    render(
      <DesignAgentPanel
        {...props({
          readOnlyHistory: true,
        })}
      />,
    );

    expect(screen.getByRole('textbox', { name: '描述页面修改' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '返回当前版' })).not.toBeInTheDocument();
  });

  it('keeps the composer available while the first Miniapp is being prepared', () => {
    render(
      <DesignAgentPanel
        {...props({ revisions: [], selectedRevisionNo: undefined, isBootstrapping: true })}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      '正在生成页面你可以继续输入，下一条修改会按顺序执行。',
    );
    expect(screen.getByRole('button', { name: '停止当前修改' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '描述页面修改' })).toBeEnabled();
  });

  it('queues an edit during bootstrap and applies it when the first revision settles', () => {
    const onSend = vi.fn(() => true);
    const { rerender } = render(
      <DesignAgentPanel
        {...props({
          revisions: [],
          selectedRevisionNo: undefined,
          isBootstrapping: true,
          onSend,
        })}
      />,
    );
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });

    fireEvent.change(composer, { target: { value: '把结果区改成卡片' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('1 条修改待执行')).toBeInTheDocument();

    rerender(
      <DesignAgentPanel {...props({ revisions: [], selectedRevisionNo: undefined, onSend })} />,
    );
    expect(onSend).toHaveBeenCalledWith('把结果区改成卡片');
  });

  it('exposes a stop action while the Design Agent is running', () => {
    const onInterrupt = vi.fn();
    render(<DesignAgentPanel {...props({ isRunning: true, onInterrupt })} />);

    fireEvent.click(screen.getByRole('button', { name: '停止当前修改' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('uses one Codex-style action for stop when empty and queue when the user types', () => {
    const onInterrupt = vi.fn();
    const onSend = vi.fn(() => true);
    render(<DesignAgentPanel {...props({ isRunning: true, onInterrupt, onSend })} />);

    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    expect(screen.getByRole('button', { name: '停止当前修改' })).toBeEnabled();

    fireEvent.change(composer, { target: { value: '再把结果区放大一些' } });
    expect(screen.queryByRole('button', { name: '停止当前修改' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加入修改队列' }));

    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('1 条修改待执行')).toBeInTheDocument();
  });

  it('keeps one continuous conversation and marks the open artifact without a no-op action', () => {
    const onOpenArtifact = vi.fn();
    render(
      <DesignAgentPanel
        {...props({
          messages: [
            {
              id: 'message-artifact',
              runId: '33333333-3333-4333-8333-333333333333',
              seq: 1,
              role: 'assistant',
              text: '首版页面已经准备好了。',
              artifacts: [
                {
                  artifactKey: 'main',
                  version: 1,
                  kind: 'html',
                  title: '每日待办管家',
                },
              ],
              createdAt: '2026-07-21T10:00:00.000Z',
            },
          ],
          onOpenArtifact,
        })}
      />,
    );

    expect(screen.getByRole('log', { name: '页面修改记录' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/已创建页面.*每日待办管家.*当前页面/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /每日待办管家.*查看/ })).not.toBeInTheDocument();
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it('keeps historical artifact events available for preview', () => {
    const onOpenArtifact = vi.fn();
    render(
      <DesignAgentPanel
        {...props({
          revisions: [
            ...props().revisions,
            {
              ...props().revisions[0]!,
              id: '44444444-4444-4444-8444-444444444444',
              revisionNo: 2,
              artifactVersion: 2,
            },
          ],
          selectedRevisionNo: 2,
          messages: [
            {
              id: 'message-artifact-history',
              runId: '33333333-3333-4333-8333-333333333333',
              seq: 1,
              role: 'assistant',
              text: '首版页面已经准备好了。',
              artifacts: [
                {
                  artifactKey: 'main',
                  version: 1,
                  kind: 'html',
                  title: '每日待办管家',
                },
              ],
              createdAt: '2026-07-21T10:00:00.000Z',
            },
          ],
          onOpenArtifact,
        })}
      />,
    );

    const event = screen.getByRole('button', { name: /已创建页面.*每日待办管家.*打开/ });
    fireEvent.click(event);
    expect(onOpenArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ artifactKey: 'main', version: 1 }),
    );
  });

  it('offers an explicit retry when the first Miniapp fails', () => {
    const onSend = vi.fn(() => true);
    render(
      <DesignAgentPanel
        {...props({
          revisions: [],
          selectedRevisionNo: undefined,
          error: '首版生成失败',
          onSend,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(onSend).toHaveBeenCalledWith(expect.stringContaining('重新生成首版页面'));
  });

  it('pauses queued edits after an interrupted or failed run', () => {
    const onSend = vi.fn(() => true);
    const { rerender } = render(<DesignAgentPanel {...props({ isRunning: true, onSend })} />);
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '把结果区改成卡片' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(screen.getByText('把结果区改成卡片')).toBeInTheDocument();

    rerender(<DesignAgentPanel {...props({ isRunning: false, error: '运行已打断。', onSend })} />);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the prompt when the run controller does not accept the send', () => {
    const onSend = vi.fn(() => false);
    render(<DesignAgentPanel {...props({ onSend })} />);
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });

    fireEvent.change(composer, { target: { value: '把结果区改成卡片' } });
    fireEvent.click(screen.getByRole('button', { name: '发送修改' }));

    expect(onSend).toHaveBeenCalledWith('把结果区改成卡片');
    expect(composer).toHaveValue('把结果区改成卡片');
  });

  it('opens page annotation mode from the same left-hand composer', () => {
    const onToggleAnnotation = vi.fn();
    render(<DesignAgentPanel {...props({ onToggleAnnotation })} />);

    const composerGroup = screen.getByRole('group', { name: '页面修改输入' });
    const annotationButton = screen.getByRole('button', { name: '标注页面' });
    expect(composerGroup).toContainElement(annotationButton);
    expect(annotationButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(annotationButton);

    expect(onToggleAnnotation).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('attaches a selected page element to the main composer and clears it after sending', () => {
    const onSend = vi.fn(() => true);
    const onClearAnnotation = vi.fn();
    render(
      <DesignAgentPanel
        {...props({ selectedElement: resultElement, onSend, onClearAnnotation })}
      />,
    );

    expect(screen.getByRole('region', { name: '当前页面标注' })).toHaveTextContent('今日安排结果');
    expect(screen.queryByText(/data-combo-key/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);

    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '收紧这里的间距，让内容更利落。' } });
    fireEvent.click(screen.getByRole('button', { name: '发送修改' }));

    expect(onSend).toHaveBeenCalledWith('收紧这里的间距，让内容更利落。', resultElement);
    expect(onClearAnnotation).toHaveBeenCalledTimes(1);
  });

  it('keeps the annotation and input when a scoped send is rejected', () => {
    const onSend = vi.fn(() => false);
    const onClearAnnotation = vi.fn();
    render(
      <DesignAgentPanel
        {...props({ selectedElement: resultElement, onSend, onClearAnnotation })}
      />,
    );
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });

    fireEvent.change(composer, { target: { value: '把这里改成更克制的卡片' } });
    fireEvent.click(screen.getByRole('button', { name: '发送修改' }));

    expect(composer).toHaveValue('把这里改成更克制的卡片');
    expect(screen.getByRole('region', { name: '当前页面标注' })).toBeInTheDocument();
    expect(onClearAnnotation).not.toHaveBeenCalled();
  });

  it('keeps the selected element snapshot when a scoped edit is queued', () => {
    const onSend = vi.fn(() => true);
    const anotherElement = {
      ...resultElement,
      key: 'run-primary',
      label: '开始整理',
      role: 'button',
      text: '开始整理',
      tagName: 'button',
    };
    const { rerender } = render(
      <DesignAgentPanel {...props({ isRunning: true, selectedElement: resultElement, onSend })} />,
    );
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '突出结果数字' } });
    fireEvent.click(screen.getByRole('button', { name: '加入修改队列' }));

    rerender(
      <DesignAgentPanel {...props({ isRunning: true, selectedElement: anotherElement, onSend })} />,
    );
    rerender(<DesignAgentPanel {...props({ selectedElement: anotherElement, onSend })} />);

    expect(onSend).toHaveBeenCalledWith('突出结果数字', resultElement);
  });

  it('disables annotation and editing actions for historical revisions', () => {
    render(
      <DesignAgentPanel
        {...props({
          readOnlyHistory: true,
          selectedElement: resultElement,
        })}
      />,
    );

    expect(screen.getByRole('button', { name: '标注页面' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '描述页面修改' })).toBeDisabled();
  });

  it('keeps selection guidance inside the composer and cancels annotation mode', () => {
    const onToggleAnnotation = vi.fn();
    render(<DesignAgentPanel {...props({ annotationEnabled: true, onToggleAnnotation })} />);

    const composerGroup = screen.getByRole('group', { name: '页面修改输入' });
    expect(composerGroup).toHaveTextContent('点击右侧页面，选择要修改的位置');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onToggleAnnotation).toHaveBeenCalledTimes(1);
  });

  it('removes an inline annotation without clearing typed text', () => {
    const onClearAnnotation = vi.fn();
    render(<DesignAgentPanel {...props({ selectedElement: resultElement, onClearAnnotation })} />);
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '只调整这里的层级' } });

    fireEvent.click(screen.getByRole('button', { name: '移除页面标注' }));

    expect(onClearAnnotation).toHaveBeenCalledTimes(1);
    expect(composer).toHaveValue('只调整这里的层级');
  });
});
