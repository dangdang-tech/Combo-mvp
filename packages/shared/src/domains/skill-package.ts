// authoring ↔ runtime 的唯一契约缝（仓库规范：两个应用只在此相遇，无代码互依）。
// 现阶段只放「类型契约」：运行时投递视图 + 版本状态 + 读契约 + 完整性校验签名。
// 待带 zod 校验器 / loader 实现、且被 authoring 与 runtime 同时依赖时，整体升格为
// packages/skill-package（见飞书《Agora 创作者中心 · 后端仓库结构规范》）。
import { z } from 'zod';
import {
  InputSchemaSchema,
  OutputSpecSchema,
  BoundariesSchema,
  type Manifest,
} from './structure.js';
import { VersionStatusSchema, type VersionStatus } from './publish.js';

// 版本状态复用 publish 域已定义的 VersionStatus（draft/published/superseded/review_rejected）。
// 注意 Manifest.status 始终是字面量 'draft'（创作态），真实发布态落在 DB 行
// （capability_versions.status）。runtime 按它判定可加载性：仅 'published' 可加载，其余拒绝。

// 运行时投递视图：runtime 加载一个已发布能力包所需的最小自洽信息。
// manifestHash 供运行时在加载前校验完整性（与 expectedHash 不符则拒绝）。
export const SkillPackageRuntimeViewSchema = z.object({
  capabilityId: z.string(),
  version: z.string(),
  status: VersionStatusSchema,
  name: z.string(),
  tagline: z.string(),
  instructions: z.string(),
  inputs: InputSchemaSchema,
  output: OutputSpecSchema,
  boundaries: BoundariesSchema,
  manifestHash: z.string(),
});
export type SkillPackageRuntimeView = z.infer<typeof SkillPackageRuntimeViewSchema>;

// 读契约：runtime 按 slug 或 id 取一个已发布能力包；未发布 / 被拒 / 不存在 → null。
// 实现侧各自落地（authoring 出 capability.published 投影 / runtime 读本地副本或调内部端点），
// 双方只依赖本类型，互不 import 对方代码。
export interface GetPublishedCapabilityInput {
  slugOrId: string;
}
export type GetPublishedCapabilityResult = SkillPackageRuntimeView | null;

// 完整性校验契约（纯函数签名；实现随 loader 一并落地）。
// runtime 加载前用它比对 manifestHash，不匹配则拒绝加载该能力包。
export type VerifyManifestHash = (canonicalManifestJson: string, expectedHash: string) => boolean;

// ───────────────────────── manifest 规范化（指纹的前半段）─────────────────────────
// 与 authoring 发布门（apps/authoring/src/modules/publish/manifest-hash.ts）的算法【逐字节一致】：
//   递归把 object 键升序排序 → 稳定可比较结构；数组保序（语义有序）。同内容、不同键插入序得同一规范串。
// 单源化到 shared 是为了让 authoring（写 hash）、runtime（校 hash）、seed（造数据）三处永不漂移。
// 注意：此处【只做规范化，不算 sha256】——sha256 需 node:crypto，会污染浏览器打包（web 也 import @cb/shared），
//   故 hash 的后半段（sha256）落在 runtime 后端（apps/runtime/src/modules/capability/manifest-hash.ts）。
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

/** manifest 规范化串（键序无关稳定串）；sha256 之 = manifest_hash。供 hash 与冻结血缘。 */
export function canonicalManifest(manifest: Manifest): string {
  return JSON.stringify(canonicalize(manifest));
}

// ───────────────────────── 投影：manifest → 运行时投递视图 ─────────────────────────
// 纯函数，无 IO / 无 crypto（浏览器安全）。创作端把已发布版的 manifest + 冻结的 manifest_hash 喂进来，
//   runtime 得到契约视图（SkillPackageRuntimeView）。hash 由 runtime 后端另算另校（见上）。
export interface ToRuntimeViewArgs {
  capabilityId: string;
  version: string;
  status: VersionStatus;
  manifest: Manifest;
  /** 发布事务冻结的 manifest_hash（capability_versions.manifest_hash 列）。 */
  manifestHash: string;
}
export function toRuntimeView(args: ToRuntimeViewArgs): SkillPackageRuntimeView {
  const { manifest } = args;
  return {
    capabilityId: args.capabilityId,
    version: args.version,
    status: args.status,
    name: manifest.name,
    tagline: manifest.tagline,
    instructions: manifest.instructions,
    inputs: manifest.inputs,
    output: manifest.output,
    boundaries: manifest.boundaries,
    manifestHash: args.manifestHash,
  };
}

// ───────────────────────── 公开能力视图（下发浏览器的安全子集）─────────────────────────
// 去掉 instructions（系统提示词，绝不出服务端）与 manifestHash（内部完整性凭据，无需暴露）。
//   附带 slug / description(goal) / starterPrompts，供试用前端渲染输入表单与引导提示。
export const PublicCapabilityViewSchema = z.object({
  capabilityId: z.string(),
  slug: z.string(),
  version: z.string(),
  status: VersionStatusSchema.optional(),
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  inputs: InputSchemaSchema,
  output: OutputSpecSchema,
  boundaries: BoundariesSchema,
  starterPrompts: z.array(z.string()),
});
export type PublicCapabilityView = z.infer<typeof PublicCapabilityViewSchema>;

export interface ToPublicViewArgs {
  capabilityId: string;
  slug: string;
  version: string;
  status?: VersionStatus;
  manifest: Manifest;
}
export function toPublicView(args: ToPublicViewArgs): PublicCapabilityView {
  const { manifest } = args;
  return {
    capabilityId: args.capabilityId,
    slug: args.slug,
    version: args.version,
    ...(args.status ? { status: args.status } : {}),
    name: manifest.name,
    tagline: manifest.tagline,
    description: manifest.goal,
    inputs: manifest.inputs,
    output: manifest.output,
    boundaries: manifest.boundaries,
    starterPrompts: manifest.starter_prompts,
  };
}
