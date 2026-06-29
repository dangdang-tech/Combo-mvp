-- 0011 · 直传 manifest 兑换回写 job_id（Codex P1-r5：manifest consume + job insert 原子 + 可恢复）。
--   背景（Codex r5 命中）：直传 `POST /import/jobs` 旧实现先 consumeUploadManifest 置 consumed_at、
--     再 createAndEnqueueImportJob；若 enqueue 失败则删/标 failed 刚建 job 并返回 503 retriable——
--     但 manifest 已 consumed，同一 uploadId 重试在 readUploadManifest/consume 处走 404 失效，503 的
--     「可重试」语义无法兑现（不可恢复）。
--   修法（与助手路径 import_pairings.job_id 同口径，统一「原子 + 可恢复」）：
--     ① consumed_at 与 job INSERT 放同一 PG 事务（要么都成、要么都不成）；
--     ② 兑换时把建出的 job_id 一并回写本列（同一事务、同一语句）；
--     ③ enqueue 失败不再删/标 failed——保留 queued 交 staleQueued sweeper 按既有 fence 补投；
--     ④ 同一 uploadId 重试在 consumed_at 已置且 job_id 已回写时，恢复返回该 job 的 JobView（非 404、不重复建 job）。
--   不变式（PG 层硬保证，与助手路径 phase='job_created' ⇒ job_id 非空 同义）：
--     consumed_at IS NOT NULL ⇒ job_id IS NOT NULL（兑换与回写在同一条 UPDATE 同时写两列，不可能脱节）。
--
--   非破坏（脊柱 §1.1 只加不减）：纯新增可空列 + FK，不改既有列/约束；历史行 job_id 为 NULL（兑换前本就无 job）。

ALTER TABLE import_uploads
  ADD COLUMN job_id uuid REFERENCES jobs(id);

-- 恢复/对账按 (owner_user_id, upload_id) 已有唯一索引定位行后读 job_id，无需额外索引。
