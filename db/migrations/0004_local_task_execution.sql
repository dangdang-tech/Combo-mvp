-- 本地执行模式只替换 extract 的执行位置；tasks、capabilities、对象键和发布语义继续复用。
-- local_task_executions 是 local Task 的一对一执行权附表，不是第二套任务表。

ALTER TABLE tasks
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'cloud'
  CONSTRAINT ck_tasks_execution_mode CHECK (execution_mode IN ('cloud', 'local'));

-- running local Task 用 infinity 作为旧版 Cloud Worker 的数据库栅栏。旧 worker 的认领和
-- stalled 扫描都只接受空租约或已过期租约，因此滚动发布期间也不会误领 local Task。
ALTER TABLE tasks
  ADD CONSTRAINT ck_tasks_local_lease_fence CHECK (
    execution_mode = 'cloud'
    OR status <> 'running'
    OR (
      lease_owner IS NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at = 'infinity'::timestamptz
    )
  );

-- 复合外键保证 local execution 的 owner 与 Task 真正归属人一致。
ALTER TABLE tasks
  ADD CONSTRAINT uq_tasks_id_owner UNIQUE (id, owner_user_id);

-- 旧索引会把 local Task 也纳入 worker 扫描，必须替换为只覆盖 cloud Task 的部分索引。
DROP INDEX idx_tasks_claimable;
CREATE INDEX idx_tasks_cloud_claimable
  ON tasks (lease_expires_at)
  WHERE status = 'running'
    AND current_step = 'extract'
    AND execution_mode = 'cloud';

CREATE TABLE local_task_executions (
  task_id                  uuid        PRIMARY KEY,
  owner_user_id            uuid        NOT NULL REFERENCES users(id),
  status                   text        NOT NULL DEFAULT 'pending'
                           CONSTRAINT ck_local_task_executions_status
                           CHECK (status IN ('pending', 'claimed', 'revoked', 'expired')),
  bind_code_hash           text        NOT NULL UNIQUE,
  bind_expires_at          timestamptz NOT NULL,
  device_public_key        jsonb,
  device_key_thumbprint    text,
  task_token_hash          text        UNIQUE,
  token_expires_at         timestamptz,
  token_version            bigint      NOT NULL DEFAULT 1,
  last_progress_seq        bigint      NOT NULL DEFAULT 0
                           CONSTRAINT ck_local_task_executions_progress_seq
                           CHECK (last_progress_seq >= 0),
  last_progress_sha256     text,
  result_status            text        NOT NULL DEFAULT 'pending'
                           CONSTRAINT ck_local_task_executions_result_status
                           CHECK (result_status IN ('pending', 'committing', 'committed')),
  result_sha256            text,
  result_capability_ids    uuid[],
  worker_version           text,
  algorithm_version        text,
  claimed_at               timestamptz,
  committed_at             timestamptz,
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_local_task_executions_task_owner
    FOREIGN KEY (task_id, owner_user_id) REFERENCES tasks(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT ck_local_task_executions_claim
    CHECK (
      (status = 'pending'
        AND device_public_key IS NULL
        AND device_key_thumbprint IS NULL
        AND task_token_hash IS NULL
        AND token_expires_at IS NULL)
      OR
      (status = 'claimed'
        AND device_public_key IS NOT NULL
        AND device_key_thumbprint IS NOT NULL
        AND task_token_hash IS NOT NULL
        AND token_expires_at IS NOT NULL)
      OR status IN ('revoked', 'expired')
    ),
  CONSTRAINT ck_local_task_executions_result
    CHECK (
      (result_status = 'pending'
        AND result_sha256 IS NULL
        AND result_capability_ids IS NULL)
      OR
      (result_status IN ('committing', 'committed')
        AND result_sha256 IS NOT NULL
        AND cardinality(result_capability_ids) > 0)
    )
);

CREATE INDEX idx_local_task_executions_bind_expiry
  ON local_task_executions (bind_expires_at)
  WHERE status = 'pending';

CREATE INDEX idx_local_task_executions_token_expiry
  ON local_task_executions (token_expires_at)
  WHERE status = 'claimed';
