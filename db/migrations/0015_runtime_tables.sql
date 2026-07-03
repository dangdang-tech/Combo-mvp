-- 0015 · 试用端 runtime 对话表（MVP 消费链路）。会话 / 对话消息 / 产物 / 产物版本。
--   命名说明：0008 已【冻结预留】另一套 runtime_sessions / artifacts（事件溯源消费模型：mode/tier_code/phase/
--     consumer_key/last_applied_command_id），那是 B-40 更重的未来设计。本 MVP 是「类 Claude Artifacts 的对话
--     runtime」，与冻结设计不同形态，故用独立前缀 rt_chat_* 命名，【绝不动】冻结预留表；两套设计的归并留作后续决策。
--   归属：apps/runtime 自有读写，authoring 不碰；与 authoring 只在能力包契约 + capability.published 事件相遇。
--   非破坏（脊柱 §1.1 只加不减）：纯新增表，IF NOT EXISTS 幂等可重入。owner_id 为匿名 cookie 身份（MVP）。
--   transcript：pi AgentMessage[] 原始转录（rehydrate agent）；rt_chat_messages：UI 形态消息（渲染对话流）。

CREATE TABLE IF NOT EXISTS rt_chat_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      text NOT NULL,
  capability_id uuid NOT NULL,
  slug          text NOT NULL,
  version       text NOT NULL,
  title         text NOT NULL DEFAULT '新会话',
  instructions  text NOT NULL,                    -- 冻结的系统提示词快照（注入 pi）
  manifest_hash text NOT NULL,                    -- 开会话时冻结，载入校验
  public_view   jsonb NOT NULL,                   -- PublicCapabilityView 快照
  transcript    jsonb NOT NULL DEFAULT '[]'::jsonb, -- pi AgentMessage[] 原始转录
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rt_chat_sessions_owner ON rt_chat_sessions (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rt_chat_sessions_cap ON rt_chat_sessions (capability_id);

CREATE TABLE IF NOT EXISTS rt_chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES rt_chat_sessions (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  text       text NOT NULL DEFAULT '',
  artifacts  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ArtifactRef[]
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_rt_chat_messages_seq UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_rt_chat_messages_session ON rt_chat_messages (session_id, seq);

CREATE TABLE IF NOT EXISTS rt_chat_artifacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES rt_chat_sessions (id) ON DELETE CASCADE,
  artifact_key   text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('html', 'markdown', 'code', 'structured')),
  title          text NOT NULL,
  latest_version integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_rt_chat_artifacts_key UNIQUE (session_id, artifact_key)
);
CREATE INDEX IF NOT EXISTS idx_rt_chat_artifacts_session ON rt_chat_artifacts (session_id);

CREATE TABLE IF NOT EXISTS rt_chat_artifact_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES rt_chat_artifacts (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  language    text,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_rt_chat_artifact_versions UNIQUE (artifact_id, version)
);
CREATE INDEX IF NOT EXISTS idx_rt_chat_artifact_versions_artifact ON rt_chat_artifact_versions (artifact_id, version);
