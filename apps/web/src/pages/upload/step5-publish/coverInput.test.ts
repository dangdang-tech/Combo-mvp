// coverInput 守卫单测（F-14，P1-6 / Codex#r1）：绝不发送半成品 cover input。
import { describe, it, expect } from 'vitest';
import { buildCoverInput, AVAILABLE_COVER_SOURCES } from './coverInput.js';

describe('buildCoverInput（半成品封面守卫）', () => {
  it('glyph：原样字形图标', () => {
    expect(buildCoverInput('glyph')).toEqual({ source: 'glyph' });
  });

  it('image 缺 assetKey → 回落 glyph（不发半成品）', () => {
    expect(buildCoverInput('image')).toEqual({ source: 'glyph' });
    expect(buildCoverInput('image', {})).toEqual({ source: 'glyph' });
  });

  it('html_snapshot 缺 snapshotRef → 回落 glyph（不发半成品）', () => {
    expect(buildCoverInput('html_snapshot')).toEqual({ source: 'glyph' });
    expect(buildCoverInput('html_snapshot', {})).toEqual({ source: 'glyph' });
  });

  it('image 带 assetKey → 完整带上（为将来上传链路落地预留）', () => {
    expect(buildCoverInput('image', { assetKey: 'k-123' })).toEqual({
      source: 'image',
      assetKey: 'k-123',
    });
  });

  it('html_snapshot 带 snapshotRef → 完整带上', () => {
    expect(buildCoverInput('html_snapshot', { snapshotRef: 's-9' })).toEqual({
      source: 'html_snapshot',
      snapshotRef: 's-9',
    });
  });

  it('image 误带 snapshotRef（错配资产引用）→ 仍回落 glyph（只认匹配的引用）', () => {
    expect(buildCoverInput('image', { snapshotRef: 's-9' })).toEqual({ source: 'glyph' });
  });

  it('本期可用来源只有 glyph', () => {
    expect(AVAILABLE_COVER_SOURCES).toEqual(['glyph']);
  });
});
