-- 0008 · 冻结 schema（B-36/B-38/B-40）。只建表、不写数据、不挂端点（70 §9）。
-- 引用列 FK 在 0009 后置补齐（FK 诚实，Codex#13）。

-- B-36 · 计量（usage_events / daily_*，唯一 DDL 真源在 70 域）
CREATE TABLE usage_events (
  event_id       text        PRIMARY KEY,
  session_id     uuid        NOT NULL,           -- → runtime_sessions（后置 FK）
  turn           int         NOT NULL,
  attempt        int         NOT NULL,
  consumer_key   text        NOT NULL,           -- intentional loose（匿名键无主体）
  capability_id  uuid,                           -- → capabilities（后置 FK）
  creator_id     uuid,                           -- → users（后置 FK）
  mode           text        NOT NULL,
  tokens         int         NOT NULL DEFAULT 0,
  cost_micros    bigint      NOT NULL DEFAULT 0,
  revenue_micros bigint      NOT NULL DEFAULT 0,
  occurred_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_creator_day ON usage_events (creator_id, occurred_at);

CREATE TABLE daily_capability_stats (
  stat_date      date        NOT NULL,
  capability_id  uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  invocations    bigint      NOT NULL DEFAULT 0,
  tokens         bigint      NOT NULL DEFAULT 0,
  cost_micros    bigint      NOT NULL DEFAULT 0,
  revenue_micros bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, capability_id)
);
CREATE INDEX idx_daily_cap_stats_cap ON daily_capability_stats (capability_id, stat_date);

CREATE TABLE daily_creator_consumers (
  stat_date    date        NOT NULL,
  creator_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consumer_key text        NOT NULL,             -- intentional loose
  PRIMARY KEY (stat_date, creator_id, consumer_key)
);
CREATE INDEX idx_daily_consumers_creator ON daily_creator_consumers (creator_id, stat_date);

CREATE TABLE daily_creator_llm_stats (
  stat_date   date        NOT NULL,
  creator_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokens      bigint      NOT NULL DEFAULT 0,
  invocations bigint      NOT NULL DEFAULT 0,
  cost_micros bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, creator_id)
);
CREATE INDEX idx_daily_creator_llm_creator ON daily_creator_llm_stats (creator_id, stat_date);

-- B-38 · 经验体
CREATE TABLE experience_packs (
  id            uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id uuid NOT NULL,                   -- → capabilities（后置 FK）
  status        text NOT NULL DEFAULT 'frozen',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exp_pack_capability UNIQUE (capability_id)
);
CREATE TABLE experience_pack_items (
  id        uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  pack_id   uuid NOT NULL REFERENCES experience_packs(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  content   jsonb NOT NULL
);
CREATE TABLE experience_pack_item_sources (
  item_id    uuid NOT NULL REFERENCES experience_pack_items(id) ON DELETE CASCADE,
  segment_id uuid NOT NULL,                      -- → session_segments（后置 FK）
  PRIMARY KEY (item_id, segment_id)
);

-- B-40 · Runtime
CREATE TABLE runtime_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id uuid NOT NULL,                   -- 复合 FK（后置）
  version_id    uuid NOT NULL,                   -- 复合 FK（后置）
  mode          text NOT NULL,
  tier_code     text,                            -- intentional loose
  phase         text NOT NULL DEFAULT 'init',
  consumer_key  text,                            -- intentional loose
  last_applied_command_id text,                  -- intentional loose
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  session_id      uuid NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  version_no      int  NOT NULL,
  base_version_no int,
  locked_blocks   jsonb,
  gen_context     jsonb,
  s3_key          text,                          -- intentional loose
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_artifact_session_ver UNIQUE (session_id, version_no)
);
