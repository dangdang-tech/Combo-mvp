import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

function files(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}
function allSql(): string {
  return files()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
    .join('\n');
}

// 2026-07-04 重设计基线：三层九表（设计真源见飞书文档「Combo 数据库表设计」）。
// 本套测试守护基线完整性；此后新增迁移按编号追加，本文件按需补断言。

const TABLES = [
  // 身份层
  'users',
  // 流水线层
  'tasks',
  'uploads',
  // 能力层
  'capabilities',
  // 试用层
  'sessions',
  'messages',
  'stream_events',
  'artifacts',
  // 保留的审计表
  'audit_llm_calls',
];

// 旧结构的表绝不允许回潮（完整清单见 git 历史；抽代表性的几张守门）。
const LEGACY_TABLES = [
  'jobs',
  'idempotency_keys',
  'drafts',
  'raw_snapshots',
  'session_segments',
  'import_uploads',
  'import_pairings',
  'capability_candidates',
  'capability_versions',
  'publications',
  'marketplace_listings',
  'outbox_events',
  'notifications',
  'rt_chat_sessions',
];

describe('migrations', () => {
  it('are ordered by numeric prefix, baseline first', () => {
    const list = files();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]).toBe('0000_baseline_schema.sql');
    const prefixes = list.map((f) => f.slice(0, 4));
    expect(prefixes).toEqual([...prefixes].sort());
  });

  it(`baseline defines all ${TABLES.length} tables of the redesign`, () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0000_baseline_schema.sql'), 'utf-8');
    for (const t of TABLES) {
      expect(sql, `missing table ${t}`).toContain(`CREATE TABLE ${t} (`);
    }
    // 全量对齐：CREATE TABLE 数量与清单一致（多一张都算漂移）。
    expect(sql.match(/CREATE TABLE /g)?.length).toBe(TABLES.length);
  });

  it('legacy tables never come back', () => {
    const sql = allSql();
    for (const t of LEGACY_TABLES) {
      expect(sql, `legacy table ${t} reappeared`).not.toContain(`CREATE TABLE ${t} (`);
    }
  });

  it('tasks carries the two orthogonal state axes plus lease and idempotency', () => {
    const sql = allSql();
    // 双轴状态：step 只有 upload/extract（发布不在这个轴上）；status 三态。
    expect(sql).toMatch(/current_step IN \('upload', 'extract'\)/);
    expect(sql).toMatch(/status IN \('running', 'succeeded', 'failed'\)/);
    for (const col of ['lease_owner', 'lease_expires_at', 'retry_count', 'last_error']) {
      expect(sql).toContain(col);
    }
    // 建任务幂等：唯一约束在表内。
    expect(sql).toMatch(/idempotency_key\s+text\s+NOT NULL UNIQUE/);
  });

  it('big content stays in object storage: storage_key columns exist, no content columns', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0000_baseline_schema.sql'), 'utf-8');
    // uploads/capabilities/artifacts 均以 storage_key 指向 MinIO。
    expect(sql.match(/storage_key/g)!.length).toBeGreaterThanOrEqual(3);
    // 产物不再把正文存库（旧 rt_chat_artifact_versions.content 的教训）。
    expect(sql).not.toMatch(/content\s+text/);
  });

  it('messages keep session-scoped ordering and native agent format', () => {
    const sql = allSql();
    expect(sql).toContain('uq_messages_session_seq UNIQUE (session_id, seq)');
    expect(sql).toMatch(/role IN \('user', 'assistant', 'tool'\)/);
  });

  it('0004 adds local execution without duplicating tasks, capabilities, or publications', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0004_local_task_execution.sql'), 'utf-8');
    expect(sql).toContain("execution_mode IN ('cloud', 'local')");
    expect(sql).toContain('CREATE TABLE local_task_executions (');
    expect(sql).toContain("execution_mode = 'cloud'");
    expect(sql).toContain("lease_expires_at = 'infinity'::timestamptz");
    expect(sql).toContain('DROP INDEX idx_tasks_claimable');
    expect(sql).toContain('idx_local_task_executions_token_expiry');
    expect(sql).toContain('result_capability_ids');
    expect(sql).toContain('last_progress_seq');
    expect(sql).not.toContain('CREATE TABLE agent_build_runs');
    expect(sql).not.toContain('CREATE TABLE agent_build_progress_events');
    expect(sql).not.toContain('CREATE TABLE agent_build_artifacts');
    expect(sql).not.toContain('CREATE TABLE agent_capability_publications');
  });

  it('0003 adds lock-free turns and per-turn message ordering', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0003_turns.sql'), 'utf-8');
    expect(sql).toContain('CREATE TABLE turns (');
    expect(sql).toMatch(/status IN \('running', 'completed', 'failed', 'interrupted'\)/);
    expect(sql).toContain("WHERE status = 'running'");
    expect(sql).toContain(
      'uq_messages_turn_idx ON messages (turn_id, idx) WHERE turn_id IS NOT NULL',
    );
    expect(sql).toContain('idx_messages_turn ON messages (turn_id) WHERE turn_id IS NOT NULL');
    expect(sql).toContain('ADD COLUMN turn_id uuid REFERENCES turns(id)');
    expect(sql).toContain('ADD COLUMN idx int');
    expect(sql).toContain('ALTER COLUMN seq DROP NOT NULL');
  });

  it('stream_events use bigserial for resumable ordering', () => {
    const sql = allSql();
    expect(sql).toMatch(/CREATE TABLE stream_events \(\n\s+id\s+bigserial\s+PRIMARY KEY/);
  });

  it('provides gen_uuid_v7 helper in the baseline', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0000_baseline_schema.sql'), 'utf-8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION gen_uuid_v7()');
  });
});
