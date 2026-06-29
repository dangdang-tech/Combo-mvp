-- 0003 · 提取域（30）。capability_candidates / candidate_evidence。
-- §11.E：uq_candidates_id_snapshot + evidence 两条复合 FK（固定约束名）。

CREATE TABLE capability_candidates (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  extract_job_id  uuid        NOT NULL REFERENCES jobs(id),
  snapshot_id     uuid        NOT NULL REFERENCES raw_snapshots(id),
  owner_user_id   uuid        NOT NULL REFERENCES users(id),
  status          text        NOT NULL DEFAULT 'generating',
  error           jsonb,
  retry_cnt       int         NOT NULL DEFAULT 0,
  slug            text        NOT NULL,
  name            text,
  intent          text,
  type            text,
  confidence      text,
  segment_count   int,
  frequency_ratio numeric(4,3),
  reusability     numeric(4,3),
  scope_coherence numeric(4,3),
  split_suggested boolean      NOT NULL DEFAULT false,
  scope           jsonb,
  reusability_breakdown jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidate_job_slug      UNIQUE (extract_job_id, slug),
  CONSTRAINT uq_candidates_id_snapshot  UNIQUE (id, snapshot_id),
  CONSTRAINT ck_candidate_status CHECK (status IN ('generating','ready','failed')),
  CONSTRAINT ck_candidate_type   CHECK (type IS NULL OR type IN ('core-workflow','recurring','occasional')),
  CONSTRAINT ck_candidate_conf   CHECK (confidence IS NULL OR confidence IN ('high','med','low'))
);
CREATE INDEX idx_candidates_job        ON capability_candidates (extract_job_id, created_at, id);
CREATE INDEX idx_candidates_owner      ON capability_candidates (owner_user_id, created_at DESC);
CREATE INDEX idx_candidates_job_status ON capability_candidates (extract_job_id, status);

CREATE TABLE candidate_evidence (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  candidate_id  uuid        NOT NULL,
  segment_id    uuid        NOT NULL,
  snapshot_id   uuid        NOT NULL REFERENCES raw_snapshots(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_evidence_candidate_segment UNIQUE (candidate_id, segment_id),
  -- §11.E 复合 FK（固定约束名）
  CONSTRAINT fk_evidence_candidate_snapshot
    FOREIGN KEY (candidate_id, snapshot_id)
    REFERENCES capability_candidates (id, snapshot_id) ON DELETE CASCADE,
  CONSTRAINT fk_evidence_segment_snapshot
    FOREIGN KEY (segment_id, snapshot_id)
    REFERENCES session_segments (id, snapshot_id)
);
CREATE INDEX idx_evidence_candidate ON candidate_evidence (candidate_id, created_at, id);
CREATE INDEX idx_evidence_segment   ON candidate_evidence (segment_id);
