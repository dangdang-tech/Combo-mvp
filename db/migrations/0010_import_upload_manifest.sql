-- 0010 · 直传路径上传 manifest（20 §2.1/§2.2，Codex P1-r2）。
--   背景：直传 `POST /import/jobs` 旧实现只按 uploadId 前缀 list() 桶——有任意对象就建 job，
--     N 分片传 1 片也进导入（违反 manifest 完整性闸；助手路径 import_pairings.landed_parts 已有闸，直传漏）。
--   修法：presign 持久化本次直传会话声明的 expected parts（clientPartId + 可选 content-hash）；
--     `POST /import/jobs` 据本表校验「所有 expected part 都已落桶」才建 job，未齐返 409（不建 job）。
--   直传与助手两路径统一走「先声明 manifest、再据 manifest 判齐」的同一完整性闸语义。
--
--   非破坏（脊柱 §1.1 只加不减）：纯新增表，不改既有列；presign 由「不写库」改为「写一行 manifest」，
--   是契约 §2.1 在 Codex P1 下的收紧（声明清单本身是后续完整性闸的前置，无业务副作用、可重放幂等）。

CREATE TABLE import_uploads (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id   uuid        NOT NULL REFERENCES users(id),
  -- 本次直传会话 id（presign 生成、贯穿断点续传与 POST /import/jobs 引用）。同 owner 内唯一。
  upload_id       text        NOT NULL,
  source          text        NOT NULL,
  -- 声明的期望分片清单（presign 落）：
  --   { "<clientPartId>": { "s3Key": "<key>", "contentSha256": "<hash|null>" }, ... }。
  --   POST /import/jobs 据此校验「每个 clientPartId 对应的 s3Key 都已落桶」才建 job（完整性闸）。
  expected_parts  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  total_bytes     bigint      NOT NULL DEFAULT 0,
  -- 兑换标记：建 job 成功后置（一次性，重放回放幂等；防同一 uploadId 重复建 job 的第二道闸，Idempotency-Key 是第一道）。
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- 同 owner 内 upload_id 唯一（presign 重放同 uploadId 走 upsert 回放同一 manifest）。
CREATE UNIQUE INDEX uq_import_uploads_owner_upload ON import_uploads (owner_user_id, upload_id);
