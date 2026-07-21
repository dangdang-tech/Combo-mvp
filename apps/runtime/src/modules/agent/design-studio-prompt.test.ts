import { describe, expect, it } from 'vitest';
import {
  hasDesignStudioPage,
  isCompleteDesignStudioHtml,
  withDesignStudioInstructions,
} from './design-studio-prompt.js';

describe('withDesignStudioInstructions', () => {
  it('preserves the capability contract and requires a versioned main HTML page', () => {
    const prompt = withDesignStudioInstructions('原能力边界：不可伪造证据。');

    expect(prompt).toContain('原能力边界：不可伪造证据。');
    expect(prompt).toContain('Combo Design Agent');
    expect(prompt).toContain('artifactKey="main"');
    expect(prompt).toContain('kind="html"');
    expect(prompt).toContain('复用同一 artifactKey 产生新版本');
  });

  it('only accepts a fresh main HTML artifact as a completed design result', () => {
    expect(
      hasDesignStudioPage([{ artifactKey: 'main', version: 2, kind: 'html', title: 'Miniapp' }]),
    ).toBe(true);
    expect(
      hasDesignStudioPage([
        { artifactKey: 'main', version: 2, kind: 'structured', title: '数据' },
        { artifactKey: 'preview', version: 1, kind: 'html', title: '预览' },
      ]),
    ).toBe(false);
    expect(hasDesignStudioPage([])).toBe(false);
  });

  it('rejects HTML labels that do not contain a complete document', () => {
    expect(
      isCompleteDesignStudioHtml(
        '<!doctype html><html><head><title>Miniapp</title></head><body>完成</body></html>',
      ),
    ).toBe(true);
    expect(isCompleteDesignStudioHtml('<div>只有片段</div>')).toBe(false);
    expect(isCompleteDesignStudioHtml(null)).toBe(false);
  });
});
