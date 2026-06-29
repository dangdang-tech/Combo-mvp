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

describe('migrations', () => {
  it('are ordered by numeric prefix', () => {
    const list = files();
    expect(list.length).toBeGreaterThanOrEqual(10);
    const prefixes = list.map((f) => f.slice(0, 4));
    expect(prefixes).toEqual([...prefixes].sort());
  });

  it('define all core base tables', () => {
    const sql = allSql();
    for (const t of ['users', 'jobs', 'idempotency_keys', 'drafts']) {
      expect(sql).toContain(`CREATE TABLE ${t} (`);
    }
  });

  it('register §11.E lineage composite constraints (fixed names)', () => {
    const sql = allSql();
    for (const name of [
      'uq_session_segments_id_snapshot',
      'uq_candidates_id_snapshot',
      'fk_evidence_candidate_snapshot',
      'fk_evidence_segment_snapshot',
      'uq_capability_versions_capability_id',
      'fk_publications_capability_version',
      'fk_listings_capability_version',
    ]) {
      expect(sql).toContain(name);
    }
  });

  it('close cross-domain FKs in post-ALTER stage (§11.G)', () => {
    const sql = allSql();
    for (const name of [
      'fk_drafts_snapshot',
      'fk_drafts_version',
      'fk_drafts_capability',
      'fk_drafts_batch',
      'fk_pairings_draft',
      'fk_capabilities_current_version',
      'fk_runtime_sessions_capability_version',
    ]) {
      expect(sql).toContain(name);
    }
  });

  it('registers structure job version-level hard lock (partial unique index, Codex P1-4)', () => {
    const sql = allSql();
    // 部分唯一索引：每个 versionId 至多一个未终态 structure job（version 级硬锁，杜绝并发双跑覆盖）。
    expect(sql).toContain('uq_structure_job_active_version');
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_structure_job_active_version/);
    expect(sql).toContain("subject_ref->>'versionId'");
    expect(sql).toMatch(/WHERE type = 'structure' AND status IN \('queued', 'running'\)/);
  });

  it('freezes cover (three sources) + visibility at version level on capability_versions (Codex r3 P1)', () => {
    const sql = allSql();
    // 封面三来源 + 可见性版本级冻结（与价格 capability_tiers 同层、按 version_id 不可变寻址）。
    for (const col of ['cover_source', 'cover_asset_key', 'cover_snapshot_ref']) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain('ck_capver_cover_source');
    expect(sql).toContain('ck_capver_visibility');
    // CHECK 约束限定枚举（封面三来源 / 可见性两态）。
    expect(sql).toMatch(/cover_source IN \('glyph','image','html_snapshot'\)/);
    expect(sql).toMatch(/visibility IN \('public','unlisted'\)/);
  });

  it('publish_batch_items has subject column (batch-repo reads/writes it); eval_reports has passed (B-31 schema)', () => {
    const sql = allSql();
    // batch-repo.ts 建批/读取依赖 publish_batch_items.subject（逐项发布入参），真实 PG 必须有此列（Codex#2）。
    expect(sql).toMatch(/subject\s+jsonb\s+NOT NULL/);
    // eval_reports 契约 B-31 预留 passed boolean（Codex#7）。
    expect(sql).toMatch(/passed\s+boolean/);
  });

  it('provides gen_uuid_v7 helper before any DEFAULT gen_uuid_v7()', () => {
    const list = files();
    expect(list[0]).toContain('extensions_and_helpers');
    expect(readFileSync(join(MIGRATIONS_DIR, list[0]!), 'utf-8')).toContain(
      'CREATE OR REPLACE FUNCTION gen_uuid_v7()',
    );
  });
});
