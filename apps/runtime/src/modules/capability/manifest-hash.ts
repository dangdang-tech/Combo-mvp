// manifest 指纹的「后半段」：sha256(canonicalManifest)。前半段（规范化串）单源化在 @cb/shared，
//   与 authoring 发布门冻结 manifest_hash 时用的算法逐字节一致——三处（写/校/造数据）永不漂移。
//   sha256 落在 runtime 后端（需 node:crypto），不进 shared（shared 被浏览器端 import，不能带 node 依赖）。
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalManifest, type Manifest, type VerifyManifestHash } from '@cb/shared';

/** manifest_hash = sha256(canonical(manifest))（与 authoring 冻结口径一致）。 */
export function manifestHash(manifest: Manifest): string {
  return createHash('sha256').update(canonicalManifest(manifest), 'utf8').digest('hex');
}

/** 契约 VerifyManifestHash 实现：拿规范化串重算 sha256 与冻结指纹定长比较。 */
export const verifyManifestHash: VerifyManifestHash = (canonicalManifestJson, expectedHash) => {
  const actual = createHash('sha256').update(canonicalManifestJson, 'utf8').digest('hex');
  return safeEqualHex(actual, expectedHash);
};

/** 便捷重载：直接拿 manifest 对象校验（内部走规范化 + verifyManifestHash）。 */
export function verifyManifest(manifest: Manifest, expectedHash: string): boolean {
  return verifyManifestHash(canonicalManifest(manifest), expectedHash);
}

/** 定长（timing-safe）十六进制比较；长度不等或非法直接 false。 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
