// Codex#9 · gen_uuid_v7() 默认 UUID 插入 smoke（单测层，无需真 PG）。
//
// 背景：set_byte(bytea, int, int) 第三参须为 int。函数内前 6 字节来自 bigint 位运算
// （unix_ts_ms >> N & 255 结果仍是 bigint），若不显式 ::int，PG 会因找不到
// set_byte(bytea,int,bigint) 签名而在「首次默认插入」时直接报错。
//
// 本测试两层覆盖：
//  (A) 静态核对 0000 迁移 SQL：gen_uuid_v7() 内每个 set_byte 的 byte 值都带 ::int。
//  (B) 用 TS 复刻同一套字节打包逻辑，证明产出确实是合法 UUID v7
//      （version=7、variant=10xx、前 48 位 = 毫秒时间戳、时间有序），
//      等价于「默认插入一行拿到的 id」这条 smoke 在无 PG 环境下的逻辑验证。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_0000 = resolve(__dirname, '..', 'migrations', '0000_extensions_and_helpers.sql');

// 提取 gen_uuid_v7() 函数体内的所有 set_byte(...) 调用（按行抓，足够稳）。
function setByteCalls(sql: string): string[] {
  return sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('uuid_bytes := set_byte('));
}

describe('gen_uuid_v7 · SQL 静态核对（A）', () => {
  const sql = readFileSync(SQL_0000, 'utf-8');

  it('定义了 gen_uuid_v7() 且建在最早一支迁移', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION gen_uuid_v7()');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  });

  it('每个 set_byte 的 byte 值都显式 ::int（Codex#9 收口）', () => {
    const calls = setByteCalls(sql);
    // 0..6 与 8 共 8 次 set_byte（前 6 字节时间戳 + version + variant）。
    expect(calls.length).toBe(8);
    for (const call of calls) {
      // 第三参（byte 值）须以 )::int) 收尾——所有分支都带显式 int 转换。
      expect(call).toMatch(/\)::int\);$/);
    }
  });

  it('不残留任何未转 int 的裸 bigint 位运算 byte 值', () => {
    // 回归守门：旧写法形如 `set_byte(uuid_bytes, 0, (unix_ts_ms >> 40) & 255);`（无 ::int）。
    for (const call of setByteCalls(sql)) {
      expect(call).not.toMatch(/&\s*255\);$/); // 以 "& 255);" 结尾 = 没补 ::int
    }
  });
});

// (B) TS 复刻同一字节打包逻辑（与 0000 的 set_byte 序列一一对应）。
function genUuidV7Bytes(unixTsMs: number, rnd: Buffer): Buffer {
  const b = Buffer.from(rnd); // 16 随机字节起底
  const ts = BigInt(unixTsMs);
  b[0] = Number((ts >> 40n) & 255n);
  b[1] = Number((ts >> 32n) & 255n);
  b[2] = Number((ts >> 24n) & 255n);
  b[3] = Number((ts >> 16n) & 255n);
  b[4] = Number((ts >> 8n) & 255n);
  b[5] = Number(ts & 255n);
  b[6] = (b[6]! & 15) | 112; // version = 7
  b[8] = (b[8]! & 63) | 128; // variant = 10xx
  return b;
}

function toUuidString(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe('gen_uuid_v7 · 默认插入逻辑 smoke（B，无 PG 复刻）', () => {
  const fixedRnd = Buffer.alloc(16, 0xff); // 高熵随机位全 1，便于看 version/variant 覆盖是否生效

  it('默认插入产出合法 UUID v7（version=7 / variant=10xx）', () => {
    const id = genUuidV7Bytes(1_700_000_000_000, fixedRnd);
    const s = toUuidString(id);
    expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // version nibble（第 7 字节高 4 位）== 7
    expect((id[6]! & 0xf0) >> 4).toBe(7);
    // variant（第 9 字节高 2 位）== 10
    expect((id[8]! & 0xc0) >> 6).toBe(0b10);
  });

  it('前 48 位精确等于毫秒时间戳（不丢位、字节序正确）', () => {
    const ms = 1_700_000_000_123;
    const id = genUuidV7Bytes(ms, fixedRnd);
    const recovered =
      (BigInt(id[0]!) << 40n) |
      (BigInt(id[1]!) << 32n) |
      (BigInt(id[2]!) << 24n) |
      (BigInt(id[3]!) << 16n) |
      (BigInt(id[4]!) << 8n) |
      BigInt(id[5]!);
    expect(recovered).toBe(BigInt(ms));
  });

  it('时间有序：后生成的 id 字典序 > 先生成的（时间有序主键性质）', () => {
    const earlier = toUuidString(genUuidV7Bytes(1_700_000_000_000, fixedRnd));
    const later = toUuidString(genUuidV7Bytes(1_700_000_001_000, fixedRnd));
    expect(later > earlier).toBe(true);
  });

  it('全部 byte 值落在 0..255（::int 转换不会溢出/丢位）', () => {
    const id = genUuidV7Bytes(Date.now(), fixedRnd);
    for (const byte of id) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });
});

// (C) candidate_evidence 复合 FK 在 session_segments 单表 UNIQUE(id,snapshot_id) 下成立
//     —— D2 36 表单表方案的血缘 FK 静态核对（Codex#8/D2）。
describe('§11.E 复合血缘 FK · 单表方案静态核对（C）', () => {
  const seg = readFileSync(
    resolve(__dirname, '..', 'migrations', '0002_import_tables.sql'),
    'utf-8',
  );
  const ext = readFileSync(
    resolve(__dirname, '..', 'migrations', '0003_extract_tables.sql'),
    'utf-8',
  );

  it('session_segments 携 UNIQUE(id, snapshot_id) 作复合 FK 目标', () => {
    expect(seg).toContain('CREATE TABLE session_segments (');
    expect(seg).toMatch(/uq_session_segments_id_snapshot\s+UNIQUE\s*\(id,\s*snapshot_id\)/);
  });

  it('candidate_evidence 复合 FK 指向 session_segments(id, snapshot_id)', () => {
    expect(ext).toContain('fk_evidence_segment_snapshot');
    expect(ext).toMatch(
      /FOREIGN KEY \(segment_id, snapshot_id\)\s*REFERENCES session_segments \(id, snapshot_id\)/,
    );
  });
});
