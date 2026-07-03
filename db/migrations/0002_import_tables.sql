-- 0002 · 导入域（20）。raw_snapshots / session_segments / import_pairings。
-- session_segments 带 §11.E 复合唯一键 uq_session_segments_id_snapshot。
-- import_pairings.draft_id 列先建、FK 后置（§11.G，破环）。

CREATE TABLE raw_snapshots (
  id                      uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id           uuid        NOT NULL REFERENCES users(id),
  import_job_id           uuid        NOT NULL REFERENCES jobs(id),
  source                  text        NOT NULL,
  sources                 text[]      NOT NULL DEFAULT '{}',
  raw_s3_key              text,
  raw_purged_at           timestamptz,
  segment_count           int         NOT NULL DEFAULT 0,
  message_count           int         NOT NULL DEFAULT 0,
  project_count           int         NOT NULL DEFAULT 0,
  time_span_from          date,
  time_span_to            date,
  redaction_report        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  redaction_ruleset_ver   text        NOT NULL,
  superseded_by           uuid        REFERENCES raw_snapshots(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_raw_snapshots_owner  ON raw_snapshots (owner_user_id, created_at DESC);
CREATE INDEX idx_raw_snapshots_job    ON raw_snapshots (import_job_id);
CREATE INDEX idx_raw_snapshots_orphan ON raw_snapshots (raw_purged_at) WHERE raw_purged_at IS NULL;

CREATE TABLE session_segments (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  snapshot_id   uuid        NOT NULL REFERENCES raw_snapshots(id) ON DELETE CASCADE,
  content_hash  text        NOT NULL,
  source        text        NOT NULL,
  title         text,
  date_label    text,
  happened_at   timestamptz,
  project       text,
  message_count int         NOT NULL DEFAULT 0,
  content       text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, content_hash),
  -- §11.E 血缘复合唯一键（供 30 域 fk_evidence_segment_snapshot 复合 FK）
  CONSTRAINT uq_session_segments_id_snapshot UNIQUE (id, snapshot_id)
);
CREATE INDEX idx_segments_snapshot      ON session_segments (snapshot_id, happened_at DESC);
CREATE INDEX idx_segments_snapshot_proj ON session_segments (snapshot_id, project);

CREATE TABLE import_pairings (
  id                uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id     uuid        NOT NULL REFERENCES users(id),
  pairing_code_hash text        NOT NULL,
  phase             text        NOT NULL DEFAULT 'waiting',
  upload_id         text,
  job_id            uuid        REFERENCES jobs(id),
  uploaded_parts    int         NOT NULL DEFAULT 0,
  total_parts       int,
  -- 上传 manifest（B-21 多分片协议，Codex P1-8）：已落地分片登记表
  --   { "<partIndex>": { "key": "<s3Key>", "hash": "<contentSha256>" }, ... }。
  --   complete 阶段据「键数 = total_parts 且 0..total_parts-1 全到齐」判断传齐才建 job；rawS3Keys 取本表 key 集。
  landed_parts      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  draft_id          uuid,                                  -- 后置 FK fk_pairings_draft（§11.G）
  attempt_count     int         NOT NULL DEFAULT 0,
  max_attempts      int         NOT NULL DEFAULT 5,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pairings_phase_chk CHECK (phase IN ('waiting','uploading','job_created','expired'))
);
CREATE UNIQUE INDEX uq_pairings_code_active ON import_pairings (pairing_code_hash)
  WHERE used_at IS NULL AND phase IN ('waiting', 'uploading');
CREATE INDEX idx_pairings_expire ON import_pairings (expires_at)
  WHERE phase NOT IN ('job_created', 'expired');
