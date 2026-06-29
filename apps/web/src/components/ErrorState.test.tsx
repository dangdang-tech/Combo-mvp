// ErrorState 测试（硬规则「绝不裸露错误码」）：只渲染 userMessage + 按 action 给退路，
// 绝不露 code/状态码/堆栈；traceId 仅作可选「反馈代码」小字。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorState, toErrorBody } from './ErrorState.js';
import { ApiError } from '../api/client.js';

describe('ErrorState 只渲染人话 + 退路', () => {
  it('渲染 userMessage 作为主文案', () => {
    render(
      <ErrorState
        error={{
          error: {
            userMessage: '登录态失效了，请重新登录。',
            retriable: false,
            action: 'escalate',
            traceId: 't',
          },
        }}
      />,
    );
    expect(screen.getByText('登录态失效了，请重新登录。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveAttribute('data-action', 'escalate');
  });

  it('action=retry → 渲染「重试」按钮并触发 onRetry', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        error={{
          error: {
            userMessage: '服务开小差了，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        }}
        onRetry={onRetry}
      />,
    );
    const btn = screen.getByRole('button', { name: '重试' });
    await userEvent.click(btn);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('action=change_input → 「去修改」触发 onChangeInput', async () => {
    const onChangeInput = vi.fn();
    render(
      <ErrorState
        error={{
          error: {
            userMessage: '输入有点问题，改一下再试。',
            retriable: false,
            action: 'change_input',
            traceId: 't',
          },
        }}
        onChangeInput={onChangeInput}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '去修改' }));
    expect(onChangeInput).toHaveBeenCalledOnce();
  });

  it('action=escalate → 「去处理」触发 onEscalate', async () => {
    const onEscalate = vi.fn();
    render(
      <ErrorState
        error={{
          error: {
            userMessage: '登录态失效了。',
            retriable: false,
            action: 'escalate',
            traceId: 't',
          },
        }}
        onEscalate={onEscalate}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '去处理' }));
    expect(onEscalate).toHaveBeenCalledOnce();
  });

  it('action=wait/none（非可展示退路三类）→ 不渲染退路按钮', () => {
    render(
      <ErrorState
        error={{
          error: {
            userMessage: '这个操作已经处理过了。',
            retriable: false,
            action: 'none',
            traceId: 't',
          },
        }}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('信封夹带 code/status/stack/details.sql → 白名单重建后 DOM 不含任何泄漏（#2 反向破坏）', () => {
    const { container } = render(
      <ErrorState
        error={{
          error: {
            userMessage: '服务开小差了，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 'tr-1',
            code: 'INTERNAL',
            status: 500,
            stack: 'Error: boom\n    at f (/srv/a.ts:1:1)',
            details: { sql: 'SELECT * FROM users', code: 'INTERNAL' },
          },
        }}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText('服务开小差了，请重试。')).toBeInTheDocument();
    const html = container.innerHTML;
    expect(html).not.toContain('INTERNAL');
    expect(html).not.toContain('SELECT');
    expect(html).not.toMatch(/\bstack\b/);
    expect(html).not.toMatch(/\b500\b/);
  });

  it('从 ApiError 提取信封，绝不渲染 code/状态码/堆栈', () => {
    const apiErr = new ApiError({
      error: {
        userMessage: '系统正在恢复，请稍候再试。',
        retriable: true,
        action: 'retry',
        traceId: 'trace-abc',
      },
    });
    const { container } = render(<ErrorState error={apiErr} onRetry={() => {}} />);
    expect(screen.getByText('系统正在恢复，请稍候再试。')).toBeInTheDocument();
    const html = container.innerHTML;
    expect(html).not.toMatch(/\b50\d\b/); // 无裸 HTTP 状态码
    expect(html).not.toMatch(/Error:/); // 无堆栈前缀
    expect(html).not.toContain('INTERNAL'); // 无内部 code
  });

  it('traceId 仅作「反馈代码」小字（非主文案、非错误码）', () => {
    render(
      <ErrorState
        error={{
          error: { userMessage: '出错了。', retriable: true, action: 'retry', traceId: 'trace-9f' },
        }}
      />,
    );
    expect(screen.getByText('trace-9f')).toBeInTheDocument();
    expect(screen.getByText(/反馈代码/)).toBeInTheDocument();
  });

  it('client-local 兜底 traceId 不显示（非真实可报障代码）', () => {
    render(<ErrorState error={new Error('totally unknown')} />);
    expect(screen.getByText('出了点小问题，请重试。')).toBeInTheDocument();
    expect(screen.queryByText(/反馈代码/)).not.toBeInTheDocument();
  });

  it('toErrorBody 收敛任意异常为人话（含退路）', () => {
    expect(toErrorBody(new Error('boom')).userMessage).toBe('出了点小问题，请重试。');
    expect(toErrorBody(undefined).action).toBe('retry');
  });

  it('toErrorBody 认裸 ErrorBody（useSSE 解包后 state.error 形态）', () => {
    // useSSE 把 SSE error 帧解包成裸 ErrorBody 存 state.error；ErrorState 须直接认它。
    const bare = {
      userMessage: '上游不稳定，请稍后重试。',
      retriable: true,
      action: 'retry',
      traceId: 't',
    };
    expect(toErrorBody(bare).userMessage).toBe('上游不稳定，请稍后重试。');
  });

  it('直接接收裸 ErrorBody 也渲染真实人话（非兜底）', () => {
    render(
      <ErrorState
        error={{
          userMessage: '这一步超时了，可重试。',
          retriable: true,
          action: 'retry',
          traceId: 't',
        }}
      />,
    );
    expect(screen.getByText('这一步超时了，可重试。')).toBeInTheDocument();
  });
});
