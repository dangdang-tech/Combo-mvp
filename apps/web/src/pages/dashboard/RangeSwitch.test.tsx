// RangeSwitch 测试（外壳首页-19）：三档 + 当前档选中标识 + 切换回调。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RangeSwitch } from './RangeSwitch.js';

describe('RangeSwitch', () => {
  it('渲染三档（近7/近30/全部）', () => {
    render(<RangeSwitch value="30d" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '近 7 天' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '近 30 天' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全部' })).toBeInTheDocument();
  });

  it('当前档有选中标识（aria-pressed）', () => {
    render(<RangeSwitch value="30d" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '近 30 天' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('点另一档 → onChange 带新 range', async () => {
    const onChange = vi.fn();
    render(<RangeSwitch value="30d" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    expect(onChange).toHaveBeenCalledWith('7d');
    await userEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(onChange).toHaveBeenCalledWith('all');
  });
});
