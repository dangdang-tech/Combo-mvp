-- 0016 · runtime 显式 Run 资源、试用会话模式与可恢复事件流。
-- 纯 additive：保留 0015 的 rt_chat_* 会话/消息/产物表，不破坏已发布消费路径。

ALTER TABLE rt_chat_sessions
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'consume'
  CHECK (mode IN ('consume', 'trial'));

ALTER TABLE rt_chat_messages
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_rt_chat_sessions_owner_mode
  ON rt_chat_sessions (owner_id, mode, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_rt_chat_sessions_cap_mode
  ON rt_chat_sessions (capability_id, mode, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_rt_chat_messages_run
  ON rt_chat_messages (run_id);

CREATE TABLE IF NOT EXISTS rt_chat_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES rt_chat_sessions (id) ON DELETE CASCADE,
  owner_id     text NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'interrupted', 'failed', 'completed')),
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_rt_chat_runs_session
  ON rt_chat_runs (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rt_chat_runs_owner
  ON rt_chat_runs (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rt_chat_run_events (
  id         bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES rt_chat_runs (id) ON DELETE CASCADE,
  event      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rt_chat_run_events_run_id
  ON rt_chat_run_events (run_id, id);
