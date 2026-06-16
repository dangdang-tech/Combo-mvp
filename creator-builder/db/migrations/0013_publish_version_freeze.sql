-- 0013 · 发布时版本级冻结：封面三来源 + 可见性（50-step5-publish §1.2，Codex#r3 P1）。
-- 铁律：发布时冻结的对外卡数据要版本级冻结。价格已落 capability_tiers(version_id,…) 不可变寻址；
--   封面（glyph/image/html_snapshot 三来源）与可见性（public/unlisted）同理，按 version_id 冻结在被发布版自身。
-- 为什么落 capability_versions（与 manifest_hash 同层）而非 publications：
--   · publications 是 mutable「当前对外态」级（一能力体一条），改版/回退都改它 → 不能承载「某一版发布时」的冻结快照。
--   · 投影/回退要读「被展示版自身」的封面/可见性（拒绝回退到上一版时，市集卡要还原上一版发布时的封面与可见性，
--     而不是被拒新版的）。把它们绑 version_id（capability_versions 行不可变寻址，与 manifest_hash/价格血缘同源）
--     才能让 MarketplaceProjection 据 capability.published.versionId 读到「那一版」的冻结值。
-- 封面三来源（发布-11/12/13/32，与 CoverInput schema 对齐）：
--   cover_source=glyph        → 字形图标（按产物类型自动生成，无引用键）。
--   cover_source=image        → cover_asset_key（上传/AI 图的对象存储键）。
--   cover_source=html_snapshot→ cover_snapshot_ref（HTML 渲染产物快照引用）。
-- 旧行（本迁移前已建的 capability_versions）：cover_source NULL = 未走过新发布门；投影 COALESCE 兜 glyph。
ALTER TABLE capability_versions
  ADD COLUMN cover_source       text,         -- 发布时冻结的封面来源（glyph|image|html_snapshot）；NULL=未冻结(旧版兜 glyph)
  ADD COLUMN cover_asset_key    text,         -- source=image 的对象存储键（冻结）
  ADD COLUMN cover_snapshot_ref text,         -- source=html_snapshot 的渲染快照引用（冻结）
  ADD COLUMN visibility         text,         -- 发布时冻结的可见性（public|unlisted）；NULL=未冻结(旧版兜 public)
  ADD CONSTRAINT ck_capver_cover_source
    CHECK (cover_source IS NULL OR cover_source IN ('glyph','image','html_snapshot')),
  ADD CONSTRAINT ck_capver_visibility
    CHECK (visibility IS NULL OR visibility IN ('public','unlisted'));
