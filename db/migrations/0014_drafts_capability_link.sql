-- 0014 · drafts 回填真实 capability_id（Codex phase4c P1-5：拒绝态读取闭环）。
--   背景（Codex r2 P1-5 命中）：drafts.id 与 capabilities.id 是不同聚合。STEP④ 结构化建版
--     （create-capability）返回真实 capabilityId，但既往只回写 drafts.version_id，没有落 capability_id；
--     STEP⑤ 单发布前端遂拿 draftId 冒充 capabilityId 读 /publications/{capabilityId} → 404 → 降级
--     publishable，拒绝原因 + 编辑重发（fromVersionId）闭环不可见。
--   修法（与 drafts.version_id 同口径，建版同事务回写真实血缘）：
--     建版同事务 backfillDraftInTx 把真实 capability_id 一并回写本列；DB 草稿续传（dashboard listDrafts）
--     据它带出 DraftView.capabilityId → 前端续传读 publication 命中真实 publication，拒绝态闭环可见。
--   不变式：drafts.capability_id 非空 ⇒ 指向已建 capabilities 行（建版同事务写，version_id/capability_id 同源）。
--
--   非破坏（脊柱 §1.1 只加不减）：纯新增可空列 + 后置 FK，不改既有列/约束；历史行 capability_id 为 NULL
--     （建版前本就无能力体；续传按既有 version_id 兜底，不回退）。

ALTER TABLE drafts
  ADD COLUMN capability_id uuid;

-- 既有在途草稿回填（Codex r2 命中：纯加列会让历史 publish/structure 草稿 hydrate 时仍缺 capabilityId，
--   续传读 publication 拒绝态仍漏）：已 backfill 过 version_id 的草稿，其能力体经 capability_versions 唯一确定，
--   据 version_id → capability_versions.capability_id 回填本列（一次性、幂等：仅填 capability_id 仍空者）。
UPDATE drafts d
   SET capability_id = v.capability_id
  FROM capability_versions v
 WHERE d.version_id = v.id
   AND d.capability_id IS NULL;

-- 后置跨域 FK（与 §11.G fk_drafts_version / fk_drafts_batch 同阶段口径，固定命名）。
ALTER TABLE drafts
  ADD CONSTRAINT fk_drafts_capability FOREIGN KEY (capability_id) REFERENCES capabilities(id);
