// CoverPicker 单测（F-14，P1-6 / Codex#r1）：非 glyph 来源 disabled 占位，不可切到半成品来源。
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CoverPicker } from './CoverPicker.js';

/** 按 data-source 取选项按钮（accessible name 含 hint 文案，不稳定，故按 data-source 定位）。 */
function option(container: HTMLElement, source: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-source="${source}"]`);
  if (!el) throw new Error(`no option for source=${source}`);
  return el;
}

describe('CoverPicker（半成品来源禁用，P1-6）', () => {
  it('glyph 可选；image / html_snapshot disabled 占位', () => {
    const { container } = render(<CoverPicker source="glyph" onChange={() => undefined} />);
    expect(option(container, 'glyph')).not.toBeDisabled();
    expect(option(container, 'image')).toBeDisabled();
    expect(option(container, 'html_snapshot')).toBeDisabled();
  });

  it('点 disabled 的 image 不触发 onChange（不切到发不出完整封面的来源）', () => {
    const onChange = vi.fn();
    const { container } = render(<CoverPicker source="glyph" onChange={onChange} />);
    fireEvent.click(option(container, 'image'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('点 glyph 正常回调（仍可选当前唯一可用来源）', () => {
    const onChange = vi.fn();
    const { container } = render(<CoverPicker source="glyph" onChange={onChange} />);
    fireEvent.click(option(container, 'glyph'));
    expect(onChange).toHaveBeenCalledWith('glyph');
  });

  it('disabled 来源带「本期未开放」占位标', () => {
    const { container } = render(<CoverPicker source="glyph" onChange={() => undefined} />);
    const badges = container.querySelectorAll('.cb-cover-picker__badge');
    expect(badges).toHaveLength(2);
  });
});
