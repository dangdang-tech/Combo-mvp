-- 0000 · 扩展与 UUID v7 生成器（脊柱 §1.3：主键用 UUID v7，时间有序）。
-- gen_uuid_v7()：PG 内置无 v7（PG18 才有 uuidv7()），此处提供 SQL 兜底实现，跨版本可用。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION gen_uuid_v7() RETURNS uuid AS $$
DECLARE
  unix_ts_ms bigint;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  -- 16 随机字节起底，再覆盖前 48 位为毫秒时间戳，写入 version(7) 与 variant(10) 位。
  -- Codex#9：所有 set_byte 的 byte 值显式 ::int。
  -- 前 6 字节来自 bigint 位运算（结果仍是 bigint），不显式转 int 会让 set_byte(bytea,int,bigint)
  -- 找不到函数签名 → 首次默认插入即报错。逐个 ::int 收口（值已 & 255，落在 0..255，转换安全）。
  uuid_bytes := gen_random_bytes(16);
  uuid_bytes := set_byte(uuid_bytes, 0, (((unix_ts_ms >> 40) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 1, (((unix_ts_ms >> 32) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 2, (((unix_ts_ms >> 24) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 3, (((unix_ts_ms >> 16) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 4, (((unix_ts_ms >> 8) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 5, ((unix_ts_ms & 255))::int);
  -- version = 7（高 4 位）；get_byte 返回 int，运算结果已是 int，仍显式 ::int 统一收口。
  uuid_bytes := set_byte(uuid_bytes, 6, (((get_byte(uuid_bytes, 6) & 15) | 112))::int);
  -- variant = 10xx
  uuid_bytes := set_byte(uuid_bytes, 8, (((get_byte(uuid_bytes, 8) & 63) | 128))::int);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;
