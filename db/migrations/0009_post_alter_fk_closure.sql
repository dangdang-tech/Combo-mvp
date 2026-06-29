-- 0009 · 后置 ALTER FK 闭合（脊柱 §11.G）。全基表建完后统一执行；约束名固定。
-- 破「drafts ↔ 导入/结构化/发布域」建表顺序环 + 冻结表 FK 诚实（Codex#13/#18-r4/#6-r2）。

-- ===== drafts 落点跨域 FK + import_pairings 反向 FK（§11.G 前 4 条）=====
ALTER TABLE drafts
  ADD CONSTRAINT fk_drafts_snapshot FOREIGN KEY (snapshot_id) REFERENCES raw_snapshots(id),
  ADD CONSTRAINT fk_drafts_version  FOREIGN KEY (version_id)  REFERENCES capability_versions(id),
  ADD CONSTRAINT fk_drafts_batch    FOREIGN KEY (batch_id)    REFERENCES publish_batches(id);

ALTER TABLE import_pairings
  ADD CONSTRAINT fk_pairings_draft  FOREIGN KEY (draft_id)    REFERENCES drafts(id);

-- ===== 40 既有后置：capabilities.current_version_id 复合 FK（§11.E，破建表循环）=====
ALTER TABLE capabilities
  ADD CONSTRAINT fk_capabilities_current_version
  FOREIGN KEY (id, current_version_id) REFERENCES capability_versions (capability_id, id);

-- ===== 70 冻结表后置 FK（§9.4，FK 诚实）=====
ALTER TABLE usage_events
  ADD CONSTRAINT fk_usage_events_session    FOREIGN KEY (session_id)    REFERENCES runtime_sessions (id),
  ADD CONSTRAINT fk_usage_events_capability FOREIGN KEY (capability_id) REFERENCES capabilities (id),
  ADD CONSTRAINT fk_usage_events_creator    FOREIGN KEY (creator_id)    REFERENCES users (id);

ALTER TABLE experience_packs
  ADD CONSTRAINT fk_experience_packs_capability
    FOREIGN KEY (capability_id) REFERENCES capabilities (id) ON DELETE CASCADE;

ALTER TABLE experience_pack_item_sources
  ADD CONSTRAINT fk_exp_item_sources_segment
    FOREIGN KEY (segment_id) REFERENCES session_segments (id) ON DELETE CASCADE;

-- runtime_sessions 复合 FK（Codex#6-r2，§11.E 注册键）
ALTER TABLE runtime_sessions
  ADD CONSTRAINT fk_runtime_sessions_capability_version
    FOREIGN KEY (capability_id, version_id)
    REFERENCES capability_versions (capability_id, id);
