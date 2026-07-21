import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesignAgentPanel, type DesignAgentPanelProps } from './DesignAgentPanel.js';

function props(overrides: Partial<DesignAgentPanelProps> = {}): DesignAgentPanelProps {
  return {
    title: '每日待办管家',
    versionLabel: '页面 v2',
    started: true,
    messages: [],
    isRunning: false,
    readOnlyHistory: false,
    error: null,
    intake: <div>首次输入</div>,
    onBack: vi.fn(),
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onReturnLatest: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...overrides,
  };
}

describe('DesignAgentPanel', () => {
  it('turns a suggested edit into an editable prompt and sends it with Enter', () => {
    const onSend = vi.fn();
    render(<DesignAgentPanel {...props({ onSend })} />);

    fireEvent.click(screen.getByRole('button', { name: '统一页面的色彩、间距和圆角' }));
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    expect(composer).toHaveValue('统一页面的色彩、间距和圆角');

    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('统一页面的色彩、间距和圆角');
  });

  it('keeps a historical page read-only until the user returns to latest', () => {
    const onReturnLatest = vi.fn();
    render(
      <DesignAgentPanel
        {...props({
          readOnlyHistory: true,
          historyVersion: 1,
          latestVersion: 3,
          onReturnLatest,
        })}
      />,
    );

    expect(screen.getByText('正在查看历史 v1')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '描述页面修改' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '返回最新版' }));
    expect(onReturnLatest).toHaveBeenCalledTimes(1);
  });

  it('shows the real first-run intake before a conversation starts', () => {
    render(<DesignAgentPanel {...props({ started: false })} />);

    expect(screen.getByText('首次输入')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '描述页面修改' })).not.toBeInTheDocument();
  });

  it('exposes a stop action while the Design Agent is running', () => {
    const onInterrupt = vi.fn();
    render(<DesignAgentPanel {...props({ isRunning: true, onInterrupt })} />);

    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
