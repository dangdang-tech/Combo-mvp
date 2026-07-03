// F-10 STEP① 配对命令框组件测试：一行命令复制 + 逐行会话状态（waiting/uploading/expired）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PairResult, PairStatusView } from '@cb/shared';
import { CommandBox } from './CommandBox.js';

function pair(over: Partial<PairResult> = {}): PairResult {
  return {
    pairId: 'p1',
    pairingCode: '123456',
    command: "curl -fsSL 'https://x/import/connect/script?code=123456' | sh",
    curlOneLiner: 'curl -fsSL agora.app/import | sh',
    expiresAt: '2026-06-17T01:00:00Z',
    ...over,
  };
}

function status(
  phase: PairStatusView['phase'],
  over: Partial<PairStatusView> = {},
): PairStatusView {
  return { pairId: 'p1', phase, ...over };
}

describe('CommandBox', () => {
  it('展示真命令（pair.command，展示=复制）+ 「复制命令」按钮', () => {
    render(
      <CommandBox
        pair={pair()}
        status={undefined}
        onCopy={() => undefined}
        onRegenerate={() => undefined}
      />,
    );
    expect(
      screen.getByText("curl -fsSL 'https://x/import/connect/script?code=123456' | sh"),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制命令' })).toBeInTheDocument();
  });

  it('点「复制命令」触发 onCopy；copied=true 显「已复制」', async () => {
    const onCopy = vi.fn();
    const { rerender } = render(
      <CommandBox
        pair={pair()}
        status={undefined}
        onCopy={onCopy}
        onRegenerate={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '复制命令' }));
    expect(onCopy).toHaveBeenCalledOnce();
    rerender(
      <CommandBox
        pair={pair()}
        status={undefined}
        onCopy={onCopy}
        copied
        onRegenerate={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();
  });

  it('waiting 态 → 「等待你在终端运行…」（永不裸转圈）', () => {
    render(
      <CommandBox
        pair={pair()}
        status={status('waiting')}
        onCopy={() => undefined}
        onRegenerate={() => undefined}
      />,
    );
    expect(screen.getByText(/等待你在终端运行/)).toBeInTheDocument();
  });

  it('uploading 态 → 量化文案「已传 X / Y 片」', () => {
    render(
      <CommandBox
        pair={pair()}
        status={status('uploading', { uploadedParts: 2, totalParts: 5 })}
        onCopy={() => undefined}
        onRegenerate={() => undefined}
      />,
    );
    expect(screen.getByText(/已传 2 \/ 5 片/)).toBeInTheDocument();
  });

  it('expired 态 → 「已经过期」+ 「重新生成命令」引导（态非错误）', async () => {
    const onRegenerate = vi.fn();
    render(
      <CommandBox
        pair={pair()}
        status={status('expired')}
        onCopy={() => undefined}
        onRegenerate={onRegenerate}
      />,
    );
    expect(screen.getByText(/已经过期/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重新生成命令' }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });
});
