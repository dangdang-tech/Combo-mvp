-- 过期上传不再伪装成 pending/processed：expired 是不可继续收片、等待/完成原始件清理的
-- 持久诊断态。raw_purged_at 仍是“对象已真删”的唯一凭据。
ALTER TABLE uploads DROP CONSTRAINT ck_uploads_status;
ALTER TABLE uploads
  ADD CONSTRAINT ck_uploads_status
  CHECK (status IN ('pending', 'raw', 'processed', 'expired'));

-- worker 每分钟找过期 pending；局部索引避免随历史上传总量做全表扫描。
CREATE INDEX idx_uploads_pending_expiry
  ON uploads (pairing_expires_at, task_id)
  WHERE status = 'pending';

-- 清理失败以 raw_purged_at IS NULL 持久重试，只扫描仍待清的 expired 行。
CREATE INDEX idx_uploads_expired_unpurged
  ON uploads (updated_at, task_id)
  WHERE status = 'expired' AND raw_purged_at IS NULL;
