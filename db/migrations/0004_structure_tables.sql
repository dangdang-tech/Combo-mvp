-- 0004 · 结构化域（40）。capabilities / capability_versions。
-- §11.E：capability_versions 带 uq_capability_versions_capability_id；
-- capabilities.current_version_id 复合 FK 后置（破建表循环，见 0009）。
-- 注：capabilities.embedding vector(1536) 为 P1（pgvector），本期不建以保证 stock PG 可跑；P1 启用 pgvector 后 ALTER ADD。

CREATE TABLE capabilities (
  id                 uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_user_id    uuid        NOT NULL REFERENCES users(id),
  slug               text        NOT NULL,
  current_version_id uuid,                                  -- 复合 FK 后置（0009）
  tags               text[]      NOT NULL DEFAULT '{}',
  total_invocations  bigint,                                -- usage 占位（脊柱 §2.2）
  -- embedding       vector(1536),                          -- P1：需 pgvector，本期不建
  status             text        NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_capabilities_slug UNIQUE (slug),
  CONSTRAINT ck_capabilities_status CHECK (status IN ('active','archived'))
);
CREATE INDEX idx_capabilities_creator ON capabilities (creator_user_id, created_at DESC);

CREATE TABLE capability_versions (
  id                  uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id       uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  version             text        NOT NULL,
  status              text        NOT NULL DEFAULT 'draft',
  manifest            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  manifest_hash       text,
  structure_state     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  source_candidate_id uuid        REFERENCES capability_candidates(id),
  reject_reason       text,
  rejected_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_capability_version UNIQUE (capability_id, version),
  -- §11.E：供下游复合 FK（current_version_id / publications / listings / runtime_sessions）
  CONSTRAINT uq_capability_versions_capability_id UNIQUE (capability_id, id),
  CONSTRAINT ck_capver_status CHECK (status IN ('draft','published','superseded','review_rejected'))
);
CREATE INDEX idx_capver_capability       ON capability_versions (capability_id, created_at DESC);
CREATE INDEX idx_capver_status           ON capability_versions (status);
CREATE INDEX idx_capver_source_candidate ON capability_versions (source_candidate_id);
