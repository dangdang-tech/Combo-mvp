-- 0001 · 核心基表（脊柱 §4/§6/§8 + 10-auth §7）。建序：users → jobs/idempotency_keys → drafts。
-- 跨域落点 FK 后置（脊柱 §11.G），见 0009_post_alter_fk_closure.sql。

-- ===== users（10-auth §7，血缘根）=====
CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  logto_user_id  text        NOT NULL,
  account        text        NOT NULL,
  email          text,
  roles          text[]      NOT NULL DEFAULT '{creator}',
  status         text        NOT NULL DEFAULT 'active',
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_status_chk CHECK (status IN ('active','disabled')),
  -- 角色集（10-auth §6.1 + 50-publish §2.6，Codex#7）：creator/consumer 双业务角色 + reviewer 评审角色。
  CONSTRAINT users_roles_chk  CHECK (roles <@ ARRAY['creator','consumer','reviewer']::text[])
);
CREATE UNIQUE INDEX uq_users_logto_user_id ON users (logto_user_id);
CREATE UNIQUE INDEX uq_users_account_lower ON users (lower(account));
CREATE UNIQUE INDEX uq_users_email_lower   ON users (lower(email)) WHERE email IS NOT NULL;

-- ===== jobs（脊柱 §6.3，任务状态唯一真源 + fencing）=====
CREATE TABLE jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  type          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'queued',
  owner_user_id uuid        NOT NULL REFERENCES users(id),
  subject_ref   jsonb,
  progress      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result        jsonb,
  error         jsonb,
  attempt_no    int         NOT NULL DEFAULT 0,
  lease_owner   text,
  lease_until   timestamptz,
  fence_token   bigint      NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT jobs_status_chk CHECK (status IN ('queued','running','completed','failed','cancelled')),
  CONSTRAINT jobs_type_chk   CHECK (type IN ('import','extract','structure','publish_batch','evaluate','runtime_gen'))
);
CREATE INDEX idx_jobs_owner_status ON jobs (owner_user_id, status, created_at DESC);
CREATE INDEX idx_jobs_lease        ON jobs (status, lease_until) WHERE status = 'running';
CREATE INDEX idx_jobs_type_status  ON jobs (type, status);

-- ===== idempotency_keys（脊柱 §4，Codex#4 租约 fence）=====
-- lease_token：每次取/夺租约生成新 token；完成更新必须匹配当前持租者（WHERE … AND lease_token=?），
--   防旧请求超时被 steal 后回来覆盖新请求的 response_ref（并发 steal 安全）。
CREATE TABLE idempotency_keys (
  scope         text        NOT NULL,
  key           text        NOT NULL,
  request_hash  text        NOT NULL,
  response_ref  jsonb,
  status        text        NOT NULL DEFAULT 'locked',
  lease_token   uuid        NOT NULL DEFAULT gen_uuid_v7(),  -- 持租 fence token（Codex#4）
  locked_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key),
  CONSTRAINT idem_status_chk CHECK (status IN ('locked','completed','failed'))
);
CREATE INDEX idx_idem_expires ON idempotency_keys (expires_at) WHERE status = 'locked';

-- ===== drafts（脊柱 §8.4，基表仅内联指向已建核心表的 FK；跨域 FK 后置）=====
CREATE TABLE drafts (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id   uuid        NOT NULL REFERENCES users(id),
  status          text        NOT NULL DEFAULT 'active',
  current_step    text        NOT NULL DEFAULT 'import',
  step_progress   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  snapshot_id     uuid,                                  -- 后置 FK fk_drafts_snapshot
  extract_job_id  uuid        REFERENCES jobs(id),
  selection       jsonb,
  version_id      uuid,                                  -- 后置 FK fk_drafts_version
  batch_id        uuid,                                  -- 后置 FK fk_drafts_batch
  title           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drafts_status_chk CHECK (status IN ('active','completed','abandoned')),
  CONSTRAINT drafts_step_chk   CHECK (current_step IN ('import','extract','select','structure','publish'))
);
CREATE INDEX idx_drafts_owner_active ON drafts (owner_user_id, status, updated_at DESC);
