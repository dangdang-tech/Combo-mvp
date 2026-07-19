import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast, ToastProvider, useToast, type ToastProps } from './toast';

// vitest 未开启 globals，@testing-library/react 不会自动清理，需要显式 cleanup。
afterEach(cleanup);

describe('Toast（纯视觉）', () => {
  it('纯 JSON props（不含任何函数）即可渲染出标题与描述', () => {
    const props: ToastProps = {
      variant: 'danger',
      title: '发布失败',
      description: '服务暂时不可用',
    };
    expect(Object.values(props).some((v) => typeof v === 'function')).toBe(false);
    const { container } = render(<Toast {...props} />);
    expect(screen.getByText('发布失败')).toBeInTheDocument();
    expect(screen.getByText('服务暂时不可用')).toBeInTheDocument();
    expect(container.querySelector('.cb-toast--danger')).not.toBeNull();
  });

  it('缺省 variant 为 info，缺省 description 时不渲染描述节点', () => {
    const { container } = render(<Toast title="已保存" />);
    expect(container.querySelector('.cb-toast--info')).not.toBeNull();
    expect(container.querySelector('.cb-toast-desc')).toBeNull();
  });
});

function Trigger({ durationMs, title }: { durationMs?: number; title: string }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast({ variant: 'ok', title, durationMs })}>
      触发
    </button>
  );
}

describe('ToastProvider + useToast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('渲染右下角 aria-live="polite" 的固定区域', () => {
    const { container } = render(
      <ToastProvider>
        <span>页面内容</span>
      </ToastProvider>,
    );
    const region = container.querySelector('.cb-toast-region');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('toast() 入队后展示，默认 4000ms 自动消失', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger title="已保存" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发' }));
    expect(screen.getByText('已保存')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByText('已保存')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('durationMs 可自定义自动消失时间', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger title="慢一点" durationMs={10000} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发' }));

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText('慢一点')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText('慢一点')).toBeNull();
  });

  it('多次调用 toast() 会同时展示多条通知', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger title="第一条" />
      </ToastProvider>,
    );
    const button = screen.getByRole('button', { name: '触发' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getAllByText('第一条')).toHaveLength(2);
  });

  it('useToast 在 Provider 外调用时抛错', () => {
    function Naked() {
      useToast();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Naked />)).toThrow('useToast() 必须在 <ToastProvider> 内部调用');
    spy.mockRestore();
  });
});
