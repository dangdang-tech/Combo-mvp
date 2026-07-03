// 50 · B-29 批量发布 handler · candidate 项 create+回填同事务原子（Codex phase4c r7 P1）。
//   缺口（Codex r7 P1，batch-structure.ts + publish-batch.ts）：旧实现 candidate 项 create-capability【独立事务 COMMIT】建版，
//     再用【另一独立事务】受保护回填 item.version_id。两笔之间若 job 被接管/lease 过期 → 回填 0 行 → item 无 version_id 但版本已落库
//     → 下个 attempt 据 candidate 复跑再 create → 重复建版。
//   修法（方案 A 原子）：create-capability 接受 onCreatedInTx 钩子，在建版【同 tx】内 fence 校验 + 回填；0 行 → 回滚整事务（建版一并回滚）。
//   本套件直测 publish_batch handler 全链路（真 create-capability INSERT + 真 backfillItemVersionInTx 同事务 + 真 ROLLBACK 记账）：
//     · 正常：candidate-only item → create（同事务原子回填）→ structure → publish published（恰 1 version）。
//     · 原子窗口（r7）：建版同事务回填那一刻被接管（fence 翻动）→ 整事务回滚（version 未提交/未残留）→ 本 attempt fencedOut（item 仍 pending/structuring，未终态）；
//        换 fence 续跑（同 worker）→ 据 candidate 重建恰 1 version、不重复建版 → published。
import { describe, it, expect } from 'vitest';
import { SOFT_FIELD_KEYS } from '@cb/shared';
import type { Manifest } from '@cb/shared';
import { asTxPool } from '../platform/events/db-tx.js';
import { createPublishBatchHandler } from '../modules/publish/job.js';
import { createPublishBatchTx, readBatch, readBatchItems } from '../modules/publish/batch-repo.js';
import { PublishBatchFakeDb, seedUser, genId } from './publish-batch-fakes.js';
import { StreamingFakeGateway } from './structure-fakes.js';
import type { QueryResultLike, JobContext, LeasedJob } from '../platform/jobs/types.js';
import type { BatchItemPublishInput } from '../modules/publish/batch-repo.js';

function ok<R>(rows: R[], rowCount = rows.length): QueryResultLike<R> {
  return { rows, rowCount };
}

interface SegRow {
  id: string;
  title: string | null;
  source: string | null;
  project: string | null;
  content: string;
}

/**
 * 组合假库：PublishBatchFakeDb（batch 三表 + publish-one 全 SQL + 早回填 UPDATE）之上，追加 create-capability 的 SQL 面
 *   （readCandidateForCreate / INSERT capabilities / INSERT capability_versions）+ structure 读写面（readVersionForStructure /
 *   readEvidenceForCandidate / writeManifestAndStateProtected）。一套 versions/capabilities 存储贯穿 create→structure→publish。
 *   测试钩子 onBackfillGuard：在「早回填 UPDATE」守门【求值前】触发，模拟 create-后-回填-那一刻被接管（fence 翻动），
 *     使同事务回填命中 0 行 → create-capability 回滚整事务（建版一并回滚，验原子无残留）。
 */
class BatchAtomicCreateFakeDb extends PublishBatchFakeDb {
  candidates = new Map<
    string,
    { id: string; owner_user_id: string; name: string | null; slug: string; status: string }
  >();
  segments = new Map<string, SegRow>();
  evidence = new Map<string, { id: string; candidate_id: string; segment_id: string }>();
  versionSourceCandidate = new Map<string, string>();
  manifestWritesCount = 0;
  /** 测试钩子：早回填 UPDATE 守门求值前触发一次（注入「create 后回填那一刻被接管」）。 */
  onBackfillGuard?: () => void;

  override async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    // findExistingDraftVersionForCandidate：本套件验证从 0 create，故没有可复用 draft。
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('JOIN capabilities c ON c.id = v.capability_id') &&
      sql.includes('v.source_candidate_id = $1') &&
      sql.includes("v.status = 'draft'")
    ) {
      return ok<R>([]);
    }

    // readCandidateForCreate（SELECT id, name, slug, status FROM capability_candidates WHERE id=$1 AND owner_user_id=$2）。
    if (
      sql.includes('FROM capability_candidates') &&
      sql.includes('WHERE id = $1 AND owner_user_id = $2')
    ) {
      const c = this.candidates.get(params[0] as string);
      if (!c || c.owner_user_id !== params[1]) return ok<R>([]);
      return ok<R>([{ id: c.id, name: c.name, slug: c.slug, status: c.status }] as R[]);
    }

    // INSERT capabilities（create-capability ① 分支建能力体）。
    if (sql.includes('INSERT INTO capabilities')) {
      this.capabilities.set(params[0] as string, {
        id: params[0] as string,
        creator_user_id: params[1] as string,
        slug: params[2] as string,
        current_version_id: null,
      });
      return ok<R>([], 1);
    }

    // INSERT capability_versions（create-capability 建首版 draft）。
    if (sql.includes('INSERT INTO capability_versions')) {
      const versionId = params[0] as string;
      const capabilityId = params[1] as string;
      const srcCand = (params[5] as string | null) ?? null;
      this.versions.set(versionId, {
        id: versionId,
        capability_id: capabilityId,
        version: params[2] as string,
        status: 'draft',
        manifest: JSON.parse(params[3] as string) as Manifest,
        manifest_hash: null,
      });
      if (srcCand) this.versionSourceCandidate.set(versionId, srcCand);
      return ok<R>([], 1);
    }

    // 早回填 UPDATE（同事务）：在守门求值前触发测试钩子（注入接管），再走父类真守门（fence 翻动 → 0 行）。
    if (
      sql.includes('UPDATE publish_batch_items bi') &&
      sql.includes('SET version_id = $4') &&
      sql.includes('bi.version_id IS NULL')
    ) {
      this.onBackfillGuard?.();
      this.onBackfillGuard = undefined; // 只触发一次（首遍接管，重试不再接管）。
      return super.query<R>(sql, params);
    }

    // readVersionForStructure（无 JOIN）。
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('v.source_candidate_id, v.capability_id, v.status') &&
      sql.includes('WHERE v.id = $1') &&
      !sql.includes('JOIN capabilities c')
    ) {
      const v = this.versions.get(params[0] as string);
      if (!v) return ok<R>([]);
      return ok<R>([
        {
          manifest: v.manifest,
          source_candidate_id: this.versionSourceCandidate.get(v.id) ?? null,
          capability_id: v.capability_id,
          status: v.status,
        },
      ] as R[]);
    }

    // readEvidenceForCandidate。
    if (
      sql.includes('FROM candidate_evidence e') &&
      sql.includes('JOIN session_segments seg') &&
      sql.includes('e.candidate_id = $1')
    ) {
      const candidateId = params[0] as string;
      const rows = [...this.evidence.values()]
        .filter((e) => e.candidate_id === candidateId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => this.segments.get(e.segment_id))
        .filter((s): s is SegRow => Boolean(s))
        .map((s) => ({
          segment_id: s.id,
          title: s.title,
          source: s.source,
          project: s.project,
          content: s.content,
        }));
      return ok<R>(rows as R[]);
    }

    // writeManifestAndStateProtected（受保护写 manifest + structure_state；fence 经 jobs running/fence_token）。
    if (
      sql.includes('UPDATE capability_versions v') &&
      sql.includes('SET manifest = $4::jsonb, structure_state = $5::jsonb') &&
      sql.includes('FROM jobs j')
    ) {
      const jobId = params[0] as string;
      const fence = Number(params[1]);
      const versionId = params[2] as string;
      const j = this.jobs.get(jobId);
      const v = this.versions.get(versionId);
      if (!j || j.fence_token !== fence || j.status !== 'running' || !v) return ok<R>([], 0); // fence out
      v.manifest = JSON.parse(params[3] as string) as Manifest;
      this.manifestWritesCount += 1;
      return ok<R>([], 1);
    }

    return super.query<R>(sql, params);
  }
}

function makeCtx(
  jobId: string,
  fenceToken: number,
): {
  ctx: JobContext;
  appended: () => Array<{ state: string; versionId?: string | null }>;
} {
  const appended: Array<{ state: string; versionId?: string | null }> = [];
  const ctx: JobContext = {
    jobId,
    traceId: 'tr-atomic',
    fenceToken,
    attemptNo: 1,
    signal: new AbortController().signal,
    isCancelled: () => false,
    async reportProgress() {},
    async reportSubtask() {},
    async appendItem(item) {
      appended.push(item as { state: string; versionId?: string | null });
    },
    async emitField() {},
    async emitSlowHint() {},
  };
  return { ctx, appended: () => appended };
}

function leased(jobId: string, fenceToken: number): LeasedJob {
  return {
    id: jobId,
    type: 'publish_batch',
    ownerUserId: 'owner',
    subjectRef: { kind: 'publish_batch' },
    attemptNo: 1,
    fenceToken,
    progress: { percent: 0, phrase: '', subtasks: [] },
  };
}

function seedCandidate(db: BatchAtomicCreateFakeDb, candidateId: string, owner: string): void {
  db.candidates.set(candidateId, {
    id: candidateId,
    owner_user_id: owner,
    name: 'PRD 炼金师',
    slug: 'prd-alchemist',
    status: 'ready',
  });
  const segId = genId('seg');
  db.segments.set(segId, {
    id: segId,
    title: '需求会话',
    source: 'doc',
    project: 'p1',
    content: '把零散需求整理成结构化 PRD，覆盖背景、目标、范围、验收标准。',
  });
  db.evidence.set(genId('ev'), { id: genId('ev'), candidate_id: candidateId, segment_id: segId });
}

async function setupBatch(
  db: BatchAtomicCreateFakeDb,
  owner: string,
  items: BatchItemPublishInput[],
): Promise<{ batchId: string; jobId: string }> {
  const created = await createPublishBatchTx(asTxPool(db), { ownerUserId: owner, items });
  db.startJob(created.jobId, 1);
  return { batchId: created.batchId, jobId: created.jobId };
}

const handler = (db: BatchAtomicCreateFakeDb) =>
  createPublishBatchHandler({ db, txPool: asTxPool(db), gateway: new StreamingFakeGateway() });

function softFieldsFilled(manifest: Manifest): boolean {
  return SOFT_FIELD_KEYS.every((f) => {
    const v = (manifest as Record<string, unknown>)[f];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.length > 0;
  });
}

describe('publish_batch handler · candidate 项 create+回填同事务原子（r7 P1 全链路）', () => {
  it('正常：candidate-only item → create（同事务原子回填 item.version_id）→ structure → published（恰 1 version、7 软字段补齐）', async () => {
    const db = new BatchAtomicCreateFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const candidateId = genId('cand');
    seedCandidate(db, candidateId, owner);

    const { batchId, jobId } = await setupBatch(db, owner, [
      { candidateId, idempotencyKey: 'k1', visibility: 'public' },
    ]);

    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);

    // 恰 1 version（create 建一版、同事务回填、不重复建版）。
    expect(db.versions.size).toBe(1);
    const ver = [...db.versions.values()][0]!;
    // item.version_id 已焊上（create+回填同 COMMIT）。
    const rows = await readBatchItems(db, batchId);
    expect(rows[0]!.versionId).toBe(ver.id);
    expect(rows[0]!.state).toBe('published');
    expect(softFieldsFilled(ver.manifest)).toBe(true);
    expect(ver.status).toBe('published');
    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(1);
    expect(b?.status).toBe('completed');
  });

  it('原子窗口（r7）：建版同事务回填那一刻被接管（fence 翻动）→ 整事务回滚（version 未提交/未残留、item 仍无指针）→ 本 attempt fencedOut；换 fence 续跑据 candidate 重建【恰 1 version】、不重复建版 → published', async () => {
    const db = new BatchAtomicCreateFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const candidateId = genId('cand');
    seedCandidate(db, candidateId, owner);

    const { batchId, jobId } = await setupBatch(db, owner, [
      { candidateId, idempotencyKey: 'k1', visibility: 'public' },
    ]);

    // 注入：早回填 UPDATE 守门求值前把 job fence 翻到 2（模拟 create 后回填那一刻被接管）→ 回填命中 0 行 → create-capability 回滚整事务。
    db.onBackfillGuard = () => {
      const j = db.jobs.get(jobId)!;
      j.fence_token = 2; // 接管换 fence。
    };

    // 第一遍（fence=1）：create 建版的 INSERT 与回填同事务；回填那一刻 fence=2 → 0 行 → 回滚整事务（建版一并回滚）。
    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);

    // 关键（原子）：版本与能力体【未提交、未残留】（整事务回滚），item 行也未焊 versionId（仍 structuring/pending、未终态）。
    expect(db.versions.size).toBe(0);
    expect(db.capabilities.size).toBe(0);
    const afterFirst = await readBatchItems(db, batchId);
    expect(afterFirst[0]!.versionId).toBeNull();
    expect(afterFirst[0]!.state).not.toBe('published');
    expect(afterFirst[0]!.state).not.toBe('failed');

    // 第二遍（新 attempt：fence=2 续跑，job 仍 running）：据 candidate 重建恰 1 version、不重复建版 → published。
    db.startJob(jobId, 2);
    await handler(db).run(leased(jobId, 2), makeCtx(jobId, 2).ctx);

    expect(db.versions.size).toBe(1); // 重建恰 1 version（第一遍原子回滚未残留 → 不重复建版）。
    expect(db.capabilities.size).toBe(1);
    const rows = await readBatchItems(db, batchId);
    expect(rows[0]!.state).toBe('published');
    expect(rows[0]!.versionId).toBe([...db.versions.values()][0]!.id);
    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(1);
    expect(b?.status).toBe('completed');
  });
});
