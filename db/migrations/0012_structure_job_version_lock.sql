-- 0012 · 结构化 Job version 级硬锁（40 §4.C/§4.F，Codex P1-4）。
-- 问题：active structure job 是「查后插」非原子；并发两个同 version 的结构化 job 都能插入，
--   互相覆盖 manifest/structure_state（受保护写 fence 各自不同，互相打架）。
-- 修法：部分唯一索引把「每个 versionId 至多一个未终态 structure job」做成 DB 级硬约束（version 级硬锁）。
--   插入第二个未终态同 version structure job → 唯一冲突（23505）→ 调用方据此回放运行中 job 或返回 423 RESOURCE_LOCKED。
--   终态（completed/failed/cancelled）job 不在索引内：版本可重新结构化（续传/重生成另起新 job，不被历史终态 job 卡死）。
-- 表达式索引建在 subject_ref->>'versionId'（结构化 job 的 subject_ref 必含 versionId）；
--   非 structure 类型 / 终态 job 经 WHERE 排除（部分索引），不占索引、不互相干扰。
CREATE UNIQUE INDEX uq_structure_job_active_version
  ON jobs ((subject_ref->>'versionId'))
  WHERE type = 'structure' AND status IN ('queued', 'running');
