import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatAbsolute, formatRelative, Timestamp, type TimestampProps } from './timestamp';

afterEach(cleanup);

// 测试统一使用不带时区后缀的 ISO 字符串（按本地时区解析），避免断言依赖运行机器的时区。

describe('formatRelative（纯函数）', () => {
  const now = '2026-07-07T12:00:00';

  it('不满一分钟显示「刚刚」', () => {
    expect(formatRelative('2026-07-07T11:59:30', now)).toBe('刚刚');
  });

  it('未来时间也归到「刚刚」，不出现负数', () => {
    expect(formatRelative('2026-07-07T13:00:00', now)).toBe('刚刚');
  });

  it('分钟、小时、天三档按整数向下取整', () => {
    expect(formatRelative('2026-07-07T11:55:00', now)).toBe('5 分钟前');
    expect(formatRelative('2026-07-07T11:00:30', now)).toBe('59 分钟前');
    expect(formatRelative('2026-07-07T09:00:00', now)).toBe('3 小时前');
    expect(formatRelative('2026-07-05T12:00:00', now)).toBe('2 天前');
  });

  it('now 支持 Date 对象注入', () => {
    expect(formatRelative('2026-07-07T11:50:00', new Date(2026, 6, 7, 12, 0, 0))).toBe('10 分钟前');
  });

  it('非 zh 的 locale 输出英文并处理单复数', () => {
    expect(formatRelative('2026-07-07T11:59:00', now, 'en-US')).toBe('1 minute ago');
    expect(formatRelative('2026-07-07T11:55:00', now, 'en-US')).toBe('5 minutes ago');
    expect(formatRelative('2026-07-06T12:00:00', now, 'en-US')).toBe('1 day ago');
  });

  it('非法输入原样返回', () => {
    expect(formatRelative('not-a-date', now)).toBe('not-a-date');
  });
});

describe('formatAbsolute（纯函数）', () => {
  it('格式化为 YYYY-MM-DD HH:mm 且补零', () => {
    expect(formatAbsolute('2026-07-07T08:05:00')).toBe('2026-07-07 08:05');
  });

  it('非法输入原样返回', () => {
    expect(formatAbsolute('not-a-date')).toBe('not-a-date');
  });
});

describe('Timestamp', () => {
  it('纯 JSON props（不含任何函数）即可渲染绝对时间', () => {
    const props: TimestampProps = { value: '2026-07-07T08:30:00' };
    expect(Object.values(props).some((v) => typeof v === 'function')).toBe(false);
    render(<Timestamp {...props} />);
    const el = screen.getByText('2026-07-07 08:30');
    expect(el.tagName).toBe('TIME');
    expect(el).toHaveClass('cb-timestamp');
    expect(el).toHaveAttribute('datetime', '2026-07-07T08:30:00');
  });

  it('relative 模式用注入的 now 渲染相对文案，且 title 仍是完整绝对时间', () => {
    const props: TimestampProps = {
      value: '2026-07-07T11:55:00',
      mode: 'relative',
      now: '2026-07-07T12:00:00',
    };
    render(<Timestamp {...props} />);
    const el = screen.getByText('5 分钟前');
    expect(el).toHaveAttribute('title', '2026-07-07 11:55:00');
  });

  it('absolute 模式的 title 也是带秒的完整绝对时间', () => {
    render(<Timestamp value="2026-07-07T08:30:42" />);
    expect(screen.getByText('2026-07-07 08:30')).toHaveAttribute('title', '2026-07-07 08:30:42');
  });

  it('locale 传给相对文案格式化', () => {
    render(
      <Timestamp
        value="2026-07-07T11:55:00"
        mode="relative"
        now="2026-07-07T12:00:00"
        locale="en-US"
      />,
    );
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
  });

  it('非法 value 原样透出便于排查', () => {
    render(<Timestamp value="not-a-date" />);
    expect(screen.getByText('not-a-date')).toBeInTheDocument();
  });
});
