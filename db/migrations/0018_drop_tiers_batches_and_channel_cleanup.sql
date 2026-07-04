-- 0018 · 删除定价与批量发布的表 + 通知渠道收敛清理（Daniel 2026-07-04 决策，与同日代码删除配套）。
--   背景：0017 删掉零使用冻结表后，本次继续裁剪「有代码但过度设计」的三块——
--     · 批量发布（B-29）：功能完整但生产零使用（publish_batches 0 行、jobs 无 publish_batch 记录），
--       其编排与将来 drafts 重构为 Task 的方向重叠，整体下线，发布入口占位；
--     · capability_tiers 定价：无计费支撑（7 行仅 1 行有价、无任何收费路径），无计费则不需要定价表；
--     · 通知渠道：email/lark 从未有投递实现，pending 行只会永远堆积，收敛为仅站内（inapp）。
--   删除顺序：先摘外键与列，再删子表、父表。

-- 批量发布：先摘 drafts 上的批次落点（0009 后置 FK + 0001 列），再删两张表（items 有 FK 指向 batches）。
ALTER TABLE drafts DROP CONSTRAINT fk_drafts_batch;
ALTER TABLE drafts DROP COLUMN batch_id;
DROP TABLE publish_batch_items;
DROP TABLE publish_batches;

-- jobs.type 枚举收窄：去掉 publish_batch（历史数据核实无一行该类型，直接重建 CHECK 安全）。
ALTER TABLE jobs DROP CONSTRAINT jobs_type_chk;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_type_chk
  CHECK (type IN ('import', 'extract', 'structure', 'evaluate', 'runtime_gen'));

-- 定价档位（版本级冻结定价）。
DROP TABLE capability_tiers;

-- 通知渠道收敛：代码已只写 inapp，清掉永远 pending 的 email/lark 存量行。
DELETE FROM notification_channels WHERE channel IN ('email', 'lark');
