-- 轮次表：轮次是自治任务且从头到尾只有一个写者；协调只用 status='running' 的 CAS 守卫。
-- 与 tasks 表的受保护写入纪律一致。消息按轮归组，历史只读 completed 轮，半截轮不可见。
CREATE TABLE turns (
  id          uuid        PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status      text        NOT NULL
              CONSTRAINT ck_turns_status CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  last_error  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX idx_turns_session ON turns (session_id, created_at);
CREATE INDEX idx_turns_running ON turns (created_at) WHERE status = 'running';

ALTER TABLE messages ADD COLUMN turn_id uuid REFERENCES turns(id);
ALTER TABLE messages ADD COLUMN idx int;
ALTER TABLE messages ALTER COLUMN seq DROP NOT NULL;
CREATE UNIQUE INDEX uq_messages_turn_idx ON messages (turn_id, idx) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_messages_turn ON messages (turn_id) WHERE turn_id IS NOT NULL;
