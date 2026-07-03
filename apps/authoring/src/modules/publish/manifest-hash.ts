// 50 · 发布门 manifest 冻结/校验纯逻辑（B-27，50-step5-publish §1.2）。无 IO、无 DB、便于单测。
//   - canonicalManifest：单源在 @cb/shared（M1 收敛）。authoring 写 hash、runtime 校 hash、seed 造数据
//     三处共用同一份规范化，永不漂移；本文件只补 sha256 的后半段（node:crypto 不可进浏览器打包，故不下沉）。
//   - manifestHash：把 manifest 规范化为稳定串后 sha256（发布事务冻结 manifest_hash）。
//     键序无关（递归排序 object 键），故同内容不同键序得同 hash；版本不可变寻址靠它（§1.2 决策）。
//   - missingPublishFields：发布前必填软字段校验（name/tagline 非空 + 价格档齐 + 封面来源合法，§1.2 步1）。
//     缺则路由层据此出 422 PUBLISH_MISSING_FIELDS（details.missingFields，发布-24）。绝不裸转圈/裸错误码。
import { createHash } from 'node:crypto';
import { canonicalManifest, type Manifest, type CoverInput, type TierInput } from '@cb/shared';

// 重导出单源规范化，保持本模块既有调用方（repo / 测试）的 import 路径不变。
export { canonicalManifest };

/** manifest_hash = sha256(canonical(manifest))（发布事务内冻结，不可变寻址，§1.2 步2）。 */
export function manifestHash(manifest: Manifest): string {
  return createHash('sha256').update(canonicalManifest(manifest), 'utf8').digest('hex');
}

/** 发布入参（封面 + 价格）—— 用于必填校验（manifest 之外的发布期入参，§1.2 步1）。 */
export interface PublishInputs {
  cover: CoverInput;
  tiers: TierInput[];
}

/**
 * 发布前必填软字段 + 入参校验（§1.2 步1 / 发布-24）。返回缺失项键数组（空 = 齐全）。
 *   - 软字段（取自 manifest 当前值）：name / tagline 非空（市集卡名称/卖点，发布-04/24）。
 *   - 封面来源：source=image 必带 assetKey；source=html_snapshot 必带 snapshotRef（缺 → 标 cover）。
 *   - 价格：至少一档且每档 priceMicros ≥ 0（zod 已挡负数；此处兜空档，标 price）。
 *   缺失项是【市集卡位置语义名】（前端据此聚焦缺处），非内部字段路径。
 */
export function missingPublishFields(manifest: Manifest, inputs: PublishInputs): string[] {
  const missing: string[] = [];
  if (!manifest.name || manifest.name.trim().length === 0) missing.push('name');
  if (!manifest.tagline || manifest.tagline.trim().length === 0) missing.push('tagline');

  // 封面：按来源校验对应引用键。glyph 无需额外（按产物类型自动生成，发布-12）。
  const cover = inputs.cover;
  if (cover.source === 'image' && (!cover.assetKey || cover.assetKey.length === 0)) {
    missing.push('cover');
  } else if (
    cover.source === 'html_snapshot' &&
    (!cover.snapshotRef || cover.snapshotRef.length === 0)
  ) {
    missing.push('cover');
  }

  // 价格：至少一档（zod min(1) 已挡空数组；防御性兜底——空档也算缺价）。
  if (!inputs.tiers || inputs.tiers.length === 0) missing.push('price');

  return missing;
}
