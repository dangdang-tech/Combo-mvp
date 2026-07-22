import { fireEvent, render, screen } from '@testing-library/react';
import type { RuntimeMessage } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChatThread } from './ChatThread.js';

function assistantMessage(overrides: Partial<RuntimeMessage> = {}): RuntimeMessage {
  return {
    id: 'message-1',
    runId: '11111111-1111-4111-8111-111111111111',
    seq: 1,
    role: 'assistant',
    text: '页面已经准备好了。',
    artifacts: [
      {
        artifactKey: 'main',
        version: 1,
        kind: 'html',
        title: 'Agent-VM 任务助手',
      },
    ],
    createdAt: '2026-07-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('ChatThread', () => {
  it('keeps the existing artifact card and assistant body in regular runtime chat', () => {
    const onOpenArtifact = vi.fn();
    const message = assistantMessage({
      text: '这是普通运行对话中的完整说明。',
      artifacts: [
        {
          artifactKey: 'report',
          version: 2,
          kind: 'markdown',
          title: '运行报告',
        },
      ],
    });
    render(
      <ChatThread messages={[message]} streamingText={null} onOpenArtifact={onOpenArtifact} />,
    );

    expect(screen.getByText('这是普通运行对话中的完整说明。')).toBeInTheDocument();
    expect(screen.queryByText('已更新页面')).not.toBeInTheDocument();
    const artifact = screen.getByRole('button', { name: /运行报告.*v2/ });
    fireEvent.click(artifact);
    expect(onOpenArtifact).toHaveBeenCalledWith(message.artifacts[0]);
  });

  it('renders the currently open Studio artifact as a non-actionable event', () => {
    const onOpenArtifact = vi.fn();
    const message = assistantMessage();
    render(
      <ChatThread
        messages={[message]}
        streamingText={null}
        artifactPresentation="event"
        activeArtifact={{ artifactKey: 'main', version: 1 }}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    expect(screen.getByLabelText(/已创建页面.*Agent-VM 任务助手.*当前页面/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Agent-VM 任务助手.*查看/ }),
    ).not.toBeInTheDocument();
    expect(onOpenArtifact).not.toHaveBeenCalled();
    expect(screen.getByText('页面已经准备好了。')).toBeInTheDocument();
  });

  it('renders later Studio artifacts as updated-page events', () => {
    render(
      <ChatThread
        messages={[
          assistantMessage({
            artifacts: [
              {
                artifactKey: 'main',
                version: 3,
                kind: 'html',
                title: 'Agent-VM 任务助手',
              },
            ],
          }),
        ]}
        streamingText={null}
        artifactPresentation="event"
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: /已更新页面.*Agent-VM 任务助手.*打开/ }),
    ).toBeInTheDocument();
  });

  it('keeps the result summary visible and collapses only the extra modification detail', () => {
    const explanationPart =
      '我已经根据你的要求完成了页面更新，统一了页面层级、色彩、间距和圆角，并保留了原有输入、执行和结果能力。接下来还可以继续描述你想调整的地方，新的修改会继续应用到这个页面。';
    const longExplanation = explanationPart.repeat(2);
    render(
      <ChatThread
        messages={[assistantMessage({ text: longExplanation })]}
        streamingText={null}
        artifactPresentation="event"
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.queryByText(longExplanation)).not.toBeInTheDocument();
    expect(screen.getAllByText(explanationPart)).toHaveLength(1);
    const toggle = screen.getByRole('button', { name: '展开修改细节' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getAllByText(explanationPart)).toHaveLength(2);
    expect(screen.getByRole('button', { name: '收起修改细节' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows the assistant conclusion before the page revision event', () => {
    render(
      <ChatThread
        messages={[
          assistantMessage({
            text: '页面结构已经整理好。\n\n补充说明会默认收起，不打断下一步修改。',
          }),
        ]}
        streamingText={null}
        artifactPresentation="event"
        activeArtifact={{ artifactKey: 'main', version: 1 }}
        onOpenArtifact={vi.fn()}
      />,
    );

    const conclusion = screen.getByText('页面结构已经整理好。');
    const event = screen.getByLabelText(/已创建页面.*当前页面/);
    expect(conclusion.compareDocumentPosition(event) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('does not collapse long assistant messages that have no artifact', () => {
    const longRuntimeAnswer = '这是一段普通运行回答。'.repeat(20);
    render(
      <ChatThread
        messages={[assistantMessage({ text: longRuntimeAnswer, artifacts: [] })]}
        streamingText={null}
        artifactPresentation="event"
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.getByText(longRuntimeAnswer)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开修改细节' })).not.toBeInTheDocument();
  });
});
