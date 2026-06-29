-- 0007 · 事件/基础设施域（70）。outbox_events / consumer_cursors / dead_events / notifications / notification_channels / audit_llm_calls。

CREATE TABLE outbox_events (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  seq           bigint      GENERATED ALWAYS AS IDENTITY,
  event_id      text        NOT NULL,
  topic         text        NOT NULL,
  aggregate_id  uuid        NOT NULL,
  payload       jsonb       NOT NULL,
  trace_id      text,
  xid           xid8        NOT NULL DEFAULT pg_current_xact_id(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_outbox_event_id UNIQUE (event_id)
);
CREATE INDEX idx_outbox_seq       ON outbox_events (seq);
CREATE INDEX idx_outbox_topic_seq ON outbox_events (topic, seq);
CREATE INDEX idx_outbox_xid       ON outbox_events (xid);
CREATE INDEX idx_outbox_created   ON outbox_events (created_at);

-- consumer_cursors：本期多 topic 版（PK = (consumer_name, topic)，70 §3.4）
CREATE TABLE consumer_cursors (
  consumer_name text        NOT NULL,
  topic         text        NOT NULL,
  last_seq      bigint      NOT NULL DEFAULT 0,
  last_event_id text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, topic)
);

CREATE TABLE dead_events (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  consumer_name text        NOT NULL,
  topic         text        NOT NULL,
  event_id      text        NOT NULL,
  outbox_seq    bigint      NOT NULL,
  payload       jsonb       NOT NULL,
  last_error    jsonb,
  attempts      int         NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  status        text        NOT NULL DEFAULT 'dead',
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  CONSTRAINT fk_dead_events_event FOREIGN KEY (event_id) REFERENCES outbox_events (event_id),
  CONSTRAINT uq_dead_event UNIQUE (consumer_name, event_id),
  CONSTRAINT ck_dead_status   CHECK (status IN ('dead', 'retrying', 'resolved')),
  CONSTRAINT ck_dead_attempts CHECK (attempts >= 0)
);
CREATE INDEX idx_dead_unresolved ON dead_events (status, next_retry_at) WHERE status <> 'resolved';
CREATE INDEX idx_dead_topic      ON dead_events (topic, status);

CREATE TABLE notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  recipient_id  uuid        NOT NULL REFERENCES users(id),
  kind          text        NOT NULL,
  title         text        NOT NULL,
  body          text,
  link          text,
  dedupe_key    text        NOT NULL,
  read_at       timestamptz,
  trace_id      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notif_dedupe UNIQUE (recipient_id, dedupe_key)
);
CREATE INDEX idx_notif_recipient_unread ON notifications (recipient_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notif_recipient_all    ON notifications (recipient_id, created_at DESC);

CREATE TABLE notification_channels (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  notification_id uuid        NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        int         NOT NULL DEFAULT 0,
  last_error      jsonb,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notif_channel UNIQUE (notification_id, channel)
);
CREATE INDEX idx_notif_channel_pending ON notification_channels (status, created_at) WHERE status = 'pending';

-- B-06 · LLM 成本审计（非计费真源）
CREATE TABLE audit_llm_calls (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id uuid        REFERENCES users(id),
  anon_key      text,
  task_class    text        NOT NULL,
  job_id        uuid        REFERENCES jobs(id),
  model         text,
  prompt_tokens int         NOT NULL DEFAULT 0,
  completion_tokens int     NOT NULL DEFAULT 0,
  cost_micros   bigint      NOT NULL DEFAULT 0,
  degraded      boolean     NOT NULL DEFAULT false,
  retries       int         NOT NULL DEFAULT 0,
  trace_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_llm_owner_day ON audit_llm_calls (owner_user_id, created_at);
CREATE INDEX idx_audit_llm_job       ON audit_llm_calls (job_id);
