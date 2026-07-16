-- 事件日志已迁至 Redis Stream，历史轮次以 messages 表为真源。
DROP TABLE IF EXISTS stream_events;
