// 封面入参守卫（F-14，P1-6 / Codex#r1）——绝不发送半成品 cover input。
//
// 铁律（§2.1/§2.3 CoverInput）：
//   - source=image    必须带 assetKey；
//   - source=html_snapshot 必须带 snapshotRef；
//   缺资产引用就发出去，后端拿到一个发不出图的封面来源 = 半成品。本期上传 / 快照渲染链路未落，
//   故 image / html_snapshot 永远凑不齐资产引用——本守卫统一兜底回落 glyph（字形图标，发布-25 默认），
//   让发布/预览入参恒为完整可发的封面。CoverPicker 已 disabled 这两项；本守卫是数据层最后一道防线。
import type { CoverInput, CoverSource } from '@cb/shared';

/** 当前可用的封面来源（本期仅 glyph；其余资产链路未落）。 */
export const AVAILABLE_COVER_SOURCES: ReadonlyArray<CoverSource> = ['glyph'];

/**
 * 由当前选中来源（+ 可选已回填的资产引用）组装一个【完整可发】的 CoverInput。
 *   - image 缺 assetKey / html_snapshot 缺 snapshotRef → 回落 glyph（不发半成品，P1-6）。
 *   - 资产引用齐备时原样带上（为将来上传/快照链路落地预留，不写死只放 glyph 的逻辑）。
 */
export function buildCoverInput(
  source: CoverSource,
  refs: { assetKey?: string; snapshotRef?: string } = {},
): CoverInput {
  if (source === 'image' && refs.assetKey) {
    return { source: 'image', assetKey: refs.assetKey };
  }
  if (source === 'html_snapshot' && refs.snapshotRef) {
    return { source: 'html_snapshot', snapshotRef: refs.snapshotRef };
  }
  // glyph，或缺资产引用的 image/html_snapshot → 一律回落字形图标（完整、可发）。
  return { source: 'glyph' };
}
