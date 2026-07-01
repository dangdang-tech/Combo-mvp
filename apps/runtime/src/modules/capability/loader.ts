// getPublishedCapability 契约实现（方案 A：直读已发布投影）。
//   按 slug 或 id 取一个【已发布】能力包：capabilities.current_version_id → capability_versions(status='published')。
//   取不到（未发布/被驳回/不存在）→ null。加载前用 manifest_hash 校验完整性，不一致 → 拒绝（防篡改/过期）。
//   只读已发布行 + 只依赖 @cb/shared，绝不 import authoring 代码（仓库边界铁律）。
import type { Pool } from 'pg';
import {
  ManifestSchema,
  toPublicView,
  toRuntimeView,
  type Manifest,
  type PublicCapabilityView,
  type SkillPackageRuntimeView,
  type VersionStatus,
} from '@cb/shared';
import { verifyManifest } from './manifest-hash.js';

export interface LoadedCapability {
  /** 含 instructions：仅服务端用（注入 systemPrompt）。 */
  view: SkillPackageRuntimeView;
  /** 下发浏览器的安全子集（无 instructions / 无 manifestHash）。 */
  publicView: PublicCapabilityView;
}

/** 加载失败原因（HTTP 层据此出人话信封）。 */
export type CapabilityLoadReason = 'not_found' | 'integrity';

export class CapabilityLoadError extends Error {
  constructor(
    public readonly reason: CapabilityLoadReason,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityLoadError';
  }
}

interface CapabilityRow {
  capability_id: string;
  slug: string;
  version: string;
  status: string;
  manifest: Manifest;
  manifest_hash: string;
}

/**
 * 按 slug 或 id 取一个已发布能力包。取不到 → null；指纹不一致 → 抛 CapabilityLoadError('integrity')。
 */
export async function getPublishedCapability(
  pool: Pool,
  slugOrId: string,
): Promise<LoadedCapability | null> {
  const res = await pool.query<CapabilityRow>(
    `SELECT v.capability_id, c.slug, v.version, v.status, v.manifest, v.manifest_hash
       FROM capabilities c
       JOIN capability_versions v ON v.id = c.current_version_id
      WHERE (c.slug = $1 OR c.id::text = $1)
        AND v.status = 'published'
        -- 仅公开能力可被试用端直读：unlisted（私享，仅 share_token 可达，且不进市集 list）必须排除，
        --   否则任何知道/猜到 slug 的人都能加载它、开会话拿到它的私有 instructions（访问控制漏洞）。
        --   share_token 试用是后续能力；本期 unlisted 不可试用，与 list.ts 排除 unlisted 保持一致。
        AND COALESCE(v.visibility, 'public') = 'public'
      LIMIT 1`,
    [slugOrId],
  );
  const row = res.rows[0];
  if (!row) return null;

  // 完整性：对【原始 manifest 对象】（authoring 当初据它冻结 hash）重算指纹比对。
  //   先校验再 zod parse——zod 会剥未知字段，若用 parse 后的对象算 hash 可能与冻结值不符。
  if (!verifyManifest(row.manifest, row.manifest_hash)) {
    throw new CapabilityLoadError('integrity', '能力包完整性校验未通过，拒绝加载');
  }

  // 读模型自防御：校验 manifest 结构合规（authoring 写的应合规，但 runtime 不盲信表内容）。
  const manifest = ManifestSchema.parse(row.manifest);
  const status = row.status as VersionStatus;

  const view = toRuntimeView({
    capabilityId: row.capability_id,
    version: row.version,
    status,
    manifest,
    manifestHash: row.manifest_hash,
  });
  const publicView = toPublicView({
    capabilityId: row.capability_id,
    slug: row.slug,
    version: row.version,
    manifest,
  });

  return { view, publicView };
}
