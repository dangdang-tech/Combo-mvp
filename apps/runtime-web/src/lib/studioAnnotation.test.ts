import { describe, expect, it } from 'vitest';
import { buildContextualStudioPrompt, formatStudioAnnotationMessage } from './studioAnnotation.js';

const element = {
  key: 'result-main',
  label: '今日安排结果',
  role: 'region',
  text: '3 项任务已经排好',
  tagName: 'section',
};

describe('studio annotation protocol', () => {
  it('keeps a stable locator and the rest-of-page constraint in model context', () => {
    const prompt = buildContextualStudioPrompt(element, '把这里改成更克制的卡片');

    expect(prompt).toContain('今日安排结果');
    expect(prompt).toContain('data-combo-key="result-main"');
    expect(prompt).toContain('保留其它区域');
  });

  it('hides the locator protocol when the scoped message is shown in conversation', () => {
    const prompt = buildContextualStudioPrompt(element, '把这里改成更克制的卡片');
    const display = formatStudioAnnotationMessage(prompt);

    expect(display).toBe('标注「今日安排结果」\n把这里改成更克制的卡片');
    expect(display).not.toContain('data-combo-key');
  });

  it('leaves normal conversation messages untouched', () => {
    expect(formatStudioAnnotationMessage('统一页面的色彩和圆角')).toBe('统一页面的色彩和圆角');
  });
});
