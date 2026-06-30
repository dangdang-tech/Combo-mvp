// 50 · B-29 批量重试再结构化守门（P0-1，Codex phase4c r3）。忠实 mock，无真 PG。
//   缺口（Codex r3 P0-1）：candidate 起源 item 早回填 versionId 后，重试旧逻辑 `if (!versionId)` 跳过结构化，
//     直接 publishing 发【未结构化 draft】（manifest 软字段空 → 缺必填 failed），违反「复用既有 versionId 续结构化、
//     不重复建版、已生成不丢」。
//   修法：判据从「无 versionId」改为「有 candidateId」（candidate 起源）：仍非终态 + 有 candidateId 的 item
//     一律 structureCandidateItem({ existingVersionId }) 续结构化（复用既有版本、不重复建版），manifest ready 才 publish。
//   本套件直测 publish_batch handler（复用 batch + structure 两个 SQL 面的组合假库）：
//     · 早回填→fencedOut→重试：复用 versionId 续结构化（versions 不增）→ manifest 软字段补齐 → published。
//     · 反向破坏：把 handler 退回「有 versionId 就跳过 structure 直发」会发出未结构化 draft（缺必填 failed）——
//       本套件断言「未结构化 candidate 版本绝不被直发 published」，跳过 structure 直发即测红。
import { describe, it, expect } from 'vitest';
import { SOFT_FIELD_KEYS } from '@cb/shared';
import type { Manifest } from '@cb/shared';
import { asTxPool } from '../platform/events/db-tx.js';
import { createPublishBatchHandler } from '../modules/publish/job.js';
import { createPublishBatchTx, readBatch, readBatchItems } from '../modules/publish/batch-repo.js';
import { PublishBatchFakeDb, seedUser, genId } from './publish-batch-fakes.js';
import { StreamingFakeGateway } from './structure-fakes.js';
import { initialManifest } from '../modules/structure/manifest.js';
import type { QueryResultLike } from '../platform/jobs/types.js';
import type { JobContext, LeasedJob } from '../platform/jobs/types.js';
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
 * 组合假库：在 PublishBatchFakeDb（batch 三表 + publish-one 全 SQL，含 capabilities/capability_versions）之上
 *   追加 structureCandidateItem 所需的 structure SQL 面（readVersionForStructure / readEvidenceForCandidate /
 *   writeManifestAndStateProtected），复用继承的 versions/capabilities 存储——一套版本存储贯穿 structure→publish。
 *   不建模 create-capability 的 INSERT（本套件场景 item 早已带 versionId，复跑走 existingVersionId 路径，不再 create）。
 */
class BatchRestructureFakeDb extends PublishBatchFakeDb {
  candidates = new Map<string, { id: string; owner_user_id: string }>();
  segments = new Map<string, SegRow>();
  evidence = new Map<string, { id: string; candidate_id: string; segment_id: string }>();

  override async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    // readVersionForStructure（无 JOIN：manifest + source_candidate_id + capability_id + status）。
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('v.source_candidate_id, v.capability_id, v.status') &&
      sql.includes('WHERE v.id = $1') &&
      !sql.includes('JOIN capabilities c')
    ) {
      const v = this.versions.get(params[0] as string);
      if (!v) return ok<R>([]);
      // PublishFakeDb VerRow 无 source_candidate_id 列；本组合库的 candidate 血缘存 (this.versionSourceCandidate)。
      const srcCand = this.versionSourceCandidate.get(v.id) ?? null;
      return ok<R>([
        {
          manifest: v.manifest,
          source_candidate_id: srcCand,
          capability_id: v.capability_id,
          status: v.status,
        },
      ] as R[]);
    }

    // readEvidenceForCandidate（candidate_evidence JOIN session_segments）。
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

  /** version → 血缘候选（本组合库存 structure 血缘，PublishFakeDb VerRow 不带此列）。 */
  versionSourceCandidate = new Map<string, string>();
  /** 受保护落 manifest 的次数（断言「续结构化确有落库」/「复用版本只补一次」）。 */
  manifestWritesCount = 0;
}

interface Cap {
  ctx: JobContext;
  appended: () => Array<{ itemId?: string; state: string; versionId?: string | null }>;
}

function makeCtx(jobId: string, fenceToken: number): Cap {
  const appended: Array<{ itemId?: string; state: string; versionId?: string | null }> = [];
  const ctx: JobContext = {
    jobId,
    traceId: 'tr-restruct',
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

/** 全空软字段的【未结构化】manifest（硬字段锁定、name/tagline 等软字段空 → 直发必缺必填）。 */
function unstructuredManifest(capabilityId: string): Manifest {
  return initialManifest(capabilityId, '0.1.0');
}

/** 播种候选 + 证据（structureCandidateItem 续结构化直读证据所需）。 */
function seedCandidateEvidence(
  db: BatchRestructureFakeDb,
  candidateId: string,
  owner: string,
): void {
  db.candidates.set(candidateId, { id: candidateId, owner_user_id: owner });
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

/** 播种一条【未结构化】candidate 版本（模拟早回填后留下的版本，manifest 软字段空）+ 候选证据。 */
function seedUnstructuredCandidateVersion(
  db: BatchRestructureFakeDb,
  owner: string,
  candidateId: string,
): { versionId: string; capabilityId: string } {
  const capabilityId = genId('cap');
  const versionId = genId('ver');
  db.capabilities.set(capabilityId, {
    id: capabilityId,
    creator_user_id: owner,
    slug: `slug-${capabilityId}`,
    current_version_id: null,
  });
  db.versions.set(versionId, {
    id: versionId,
    capability_id: capabilityId,
    version: '0.1.0',
    status: 'draft',
    manifest: unstructuredManifest(capabilityId),
    manifest_hash: null,
  });
  db.versionSourceCandidate.set(versionId, candidateId);
  seedCandidateEvidence(db, candidateId, owner);
  return { versionId, capabilityId };
}

/** 建一批（item 携 candidateId + 早回填的 versionId）+ 起 job running。 */
async function setupBatch(
  db: BatchRestructureFakeDb,
  owner: string,
  items: BatchItemPublishInput[],
): Promise<{ batchId: string; jobId: string }> {
  const created = await createPublishBatchTx(asTxPool(db), { ownerUserId: owner, items });
  db.startJob(created.jobId, 1);
  // 把早回填语义焊到 item 行：建批只落 candidate_id/version_id 自 subject，这里把 version_id 显式置上（早回填已发生）。
  for (const it of items) {
    const row = [...db.items.values()].find((r) => r.idempotency_key === it.idempotencyKey);
    if (row && it.versionId) row.version_id = it.versionId;
  }
  return { batchId: created.batchId, jobId: created.jobId };
}

const handler = (db: BatchRestructureFakeDb) =>
  createPublishBatchHandler({ db, txPool: asTxPool(db), gateway: new StreamingFakeGateway() });

function softFieldsFilled(manifest: Manifest): boolean {
  return SOFT_FIELD_KEYS.every((f) => {
    const v = (manifest as Record<string, unknown>)[f];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.length > 0;
  });
}

describe('publish_batch handler · 批量重试再结构化（P0-1，Codex r3）', () => {
  it('早回填 versionId（未结构化）的 candidate item → 重试复用既有版本【续结构化】、不重复建版、manifest ready 才 published', async () => {
    const db = new BatchRestructureFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const candidateId = genId('cand');
    // 早回填留下的【未结构化】版本（manifest 软字段空）。
    const { versionId } = seedUnstructuredCandidateVersion(db, owner, candidateId);
    const versionsBefore = db.versions.size;

    // item 同时带 candidateId + 早回填 versionId（缺价 → worker 补默认免费档，与 §5.3 一致）。
    const { batchId, jobId } = await setupBatch(db, owner, [
      { candidateId, versionId, idempotencyKey: 'k1', visibility: 'public' },
    ]);

    const cap = makeCtx(jobId, 1);
    await handler(db).run(leased(jobId, 1), cap.ctx);

    // 复用既有版本续结构化：versions 不增（不重复建版，已生成不丢）。
    expect(db.versions.size).toBe(versionsBefore);
    // 续结构化把 7 软字段补齐进 manifest（受保护落库恰一次）。
    expect(db.manifestWritesCount).toBe(1);
    expect(softFieldsFilled(db.versions.get(versionId)!.manifest)).toBe(true);

    // manifest ready 后才发布 → published（不再因未结构化缺必填 failed）。
    const rows = await readBatchItems(db, batchId);
    expect(rows[0]!.state).toBe('published');
    expect(rows[0]!.versionId).toBe(versionId); // 同一版本（不重复建版）。
    const b = await readBatch(db, batchId);
    expect(b?.publishedCount).toBe(1);
    expect(b?.failedCount).toBe(0);
    expect(b?.status).toBe('completed');
    // 该版本确已 published（经发布门，非直发未结构化 draft）。
    expect(db.versions.get(versionId)!.status).toBe('published');
  });

  it('反向破坏守门：未结构化 candidate 版本【绝不被直发】——发布的版本 manifest 必已结构化 ready（跳过 structure 直发即测红）', async () => {
    // 守门不变量：任何被本批 published 的 candidate 版本，其 manifest 软字段必【已补齐】（经 structure ready）。
    //   若把 handler 退回「有 versionId 就跳过 structure 直发」，未结构化版本会走发布门：name/tagline 空 → 缺必填 failed
    //   （不会 published），故下面「published 且 manifest 已结构化」断言会失败（红），守住「不直发未结构化 draft」。
    const db = new BatchRestructureFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const candidateId = genId('cand');
    const { versionId } = seedUnstructuredCandidateVersion(db, owner, candidateId);

    const { batchId } = await setupBatch(db, owner, [
      { candidateId, versionId, idempotencyKey: 'k1', visibility: 'public' },
    ]);
    const jobId = [...db.jobs.values()][0]!.id;
    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);

    const rows = await readBatchItems(db, batchId);
    const item = rows[0]!;
    // 被发布的版本：manifest 必已结构化 ready（守门——直发未结构化会 failed，published+ready 同时成立才过）。
    expect(item.state).toBe('published');
    expect(softFieldsFilled(db.versions.get(versionId)!.manifest)).toBe(true);
    expect(db.versions.get(versionId)!.status).toBe('published');
  });

  it('已结构化 ready 的 candidate 版本重试（发布门曾瞬时失败）→ 复用版本、不重复结构化、不重复建版、published（幂等）', async () => {
    // existingVersionId 复跑且本版【已结构化完整】：短路确认 ready（不再读证据/不再生成/不重复落 manifest），直接发布。
    const db = new BatchRestructureFakeDb();
    const owner = seedUser(db, 'WAYNE');
    const candidateId = genId('cand');
    const { versionId } = seedUnstructuredCandidateVersion(db, owner, candidateId);
    // 预先把该版本结构化完整（模拟上一轮已 structure ready，但发布门瞬时失败未 published）。
    const mf = db.versions.get(versionId)!.manifest as Record<string, unknown>;
    mf.name = '需求炼金师';
    mf.tagline = '把对话炼成可复用的能力';
    mf.role = '产品分析助手';
    mf.goal = '从会话提炼 PRD 结构';
    mf.instructions = '根据 {{topic}} 生成结构化产物';
    mf.skill_set = ['需求拆解'];
    mf.starter_prompts = ['帮我把这段对话整理成 PRD'];
    // 证据清弃（模拟原文已 purge）：已 ready 版本不应因无证据失败（短路）。
    db.evidence.clear();
    db.segments.clear();
    const versionsBefore = db.versions.size;

    const { batchId } = await setupBatch(db, owner, [
      { candidateId, versionId, idempotencyKey: 'k1', visibility: 'public' },
    ]);
    const jobId = [...db.jobs.values()][0]!.id;
    await handler(db).run(leased(jobId, 1), makeCtx(jobId, 1).ctx);

    // 短路确认 ready：不重复落 manifest（已 ready），不重复建版。
    expect(db.manifestWritesCount).toBe(0);
    expect(db.versions.size).toBe(versionsBefore);
    const rows = await readBatchItems(db, batchId);
    expect(rows[0]!.state).toBe('published');
    expect(db.versions.get(versionId)!.status).toBe('published');
  });
});
