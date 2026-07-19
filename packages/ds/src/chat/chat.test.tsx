import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, Message, Thread } from './chat';

// vitest 未开启 globals，Testing Library 不会自动清理，需要手动在每个用例后卸载。
afterEach(cleanup);

describe('Thread', () => {
  it('纯 JSON props 渲染：默认限宽 md，子内容原样输出', () => {
    render(
      <Thread>
        <Message role="user">你好</Message>
      </Thread>,
    );
    const log = screen.getByRole('log');
    expect(log).toHaveClass('cb-thread', 'cb-thread--md');
    expect(screen.getByText('你好')).toBeInTheDocument();
  });

  it('maxWidth="lg" 时切换限宽档位', () => {
    render(<Thread maxWidth="lg">内容</Thread>);
    expect(screen.getByRole('log')).toHaveClass('cb-thread--lg');
  });
});

describe('Message', () => {
  it('纯 JSON props 渲染：user 消息带作者与格式化时间', () => {
    render(
      <Message role="user" author="你" timestamp="2026-07-07T09:30:00">
        帮我看下数据
      </Message>,
    );
    expect(screen.getByText('帮我看下数据')).toBeInTheDocument();
    expect(screen.getByText('你')).toBeInTheDocument();
    expect(screen.getByText('09:30')).toBeInTheDocument();
    expect(screen.getByText('帮我看下数据').closest('.cb-msg')).toHaveClass('cb-msg--user');
  });

  it('assistant 与 system 分别使用各自的角色样式类', () => {
    render(
      <>
        <Message role="assistant">助手回复</Message>
        <Message role="system">会话已恢复</Message>
      </>,
    );
    expect(screen.getByText('助手回复').closest('.cb-msg')).toHaveClass('cb-msg--assistant');
    expect(screen.getByText('会话已恢复').closest('.cb-msg')).toHaveClass('cb-msg--system');
  });

  it('无法解析的 timestamp 原样显示', () => {
    render(
      <Message role="user" timestamp="刚刚">
        内容
      </Message>,
    );
    expect(screen.getByText('刚刚')).toBeInTheDocument();
  });

  it('pending 时内容区显示呼吸点而不是 children', () => {
    render(
      <Message role="assistant" pending>
        不应显示的正文
      </Message>,
    );
    expect(screen.getByRole('status', { name: '正在生成回复' })).toBeInTheDocument();
    expect(screen.queryByText('不应显示的正文')).not.toBeInTheDocument();
  });
});

describe('Composer', () => {
  it('纯 JSON props 渲染：不传任何回调也能渲染占位符、初始值与发送按钮', () => {
    render(<Composer placeholder="说点什么" defaultValue="草稿内容" />);
    const textarea = screen.getByRole('textbox', { name: '消息输入框' });
    expect(textarea).toHaveAttribute('placeholder', '说点什么');
    expect(textarea).toHaveValue('草稿内容');
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('纯 JSON props 下按 Enter 不报错（onSubmit 只是可选增强）', () => {
    render(<Composer defaultValue="hi" />);
    const textarea = screen.getByRole('textbox', { name: '消息输入框' });
    expect(() => fireEvent.keyDown(textarea, { key: 'Enter' })).not.toThrow();
  });

  it('disabled 时输入框不可用', () => {
    render(<Composer disabled />);
    expect(screen.getByRole('textbox', { name: '消息输入框' })).toBeDisabled();
  });

  it('sending 时渲染正常且 Enter 不触发 onSubmit', () => {
    const onSubmit = vi.fn();
    render(<Composer sending defaultValue="发送中" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '消息输入框' }), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter 提交去除首尾空白的文本并清空输入框', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox', { name: '消息输入框' });
    fireEvent.change(textarea, { target: { value: '  先推第二款  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('先推第二款');
    expect(textarea).toHaveValue('');
  });

  it('空白文本按 Enter 不触发 onSubmit', () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox', { name: '消息输入框' });
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Shift+Enter 不提交（留给换行）', () => {
    const onSubmit = vi.fn();
    render(<Composer defaultValue="第一行" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '消息输入框' }), {
      key: 'Enter',
      shiftKey: true,
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('点击发送按钮提交文本', () => {
    const onSubmit = vi.fn();
    render(<Composer defaultValue="点按钮发送" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onSubmit).toHaveBeenCalledWith('点按钮发送');
  });
});
