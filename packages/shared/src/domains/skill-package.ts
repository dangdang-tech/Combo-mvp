// authoring ↔ runtime 的唯一契约缝（仓库规范：两个应用只在此相遇，无代码互依）。
// 现阶段只放「类型契约」：运行时投递视图 + 版本状态 + 读契约 + 完整性校验签名。
// 待带 zod 校验器 / loader 实现、且被 authoring 与 runtime 同时依赖时，整体升格为
// packages/skill-package（见飞书《Agora 创作者中心 · 后端仓库结构规范》）。
import { z } from 'zod';
import { InputSchemaSchema, OutputSpecSchema, BoundariesSchema } from './structure.js';
import { VersionStatusSchema } from './publish.js';

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
