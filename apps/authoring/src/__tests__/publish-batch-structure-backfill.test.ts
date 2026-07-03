// 50 · B-29 批编排「已生成不丢 + 重试不重复建版」原子窗口守门（§5.3、开工总纲 §5.3，Codex phase4c r7 P1）。
//   缺口（Codex r7 P1）：旧实现 create-capability【独立事务 COMMIT】建新 capability/version，再用【另一独立事务】
//     受保护回填 item.version_id。两笔之间有原子性窗口——若 create COMMIT 后、回填前 job 被接管/lease 过期（fence 翻动），
//     回填命中 0 行 → item 仍无 version_id，但版本已 COMMIT 落库 → 下个 attempt 据 candidate 复跑再 create → 【重复建版】。
//     旧测试只覆盖「早回填成功后再 fencedOut」（版本已焊到 item 行，重试复用），未覆盖这个【更早】的 create-后-回填-前窗口。
//   修法（方案 A 原子）：把 create-capability 的建体 INSERT 与 item.version_id 回填【合成同一受保护事务】——
//     create-capability 接受 onCreatedInTx 钩子，在建体同 tx 内 fence 校验 + 回填；0 行（被接管/换 fence）→ 钩子返 false →
//     抛 CreateCapabilityFencedError 回滚整事务（建体一并回滚，version 未提交）→ structureCandidateItem 走 fencedOut。
//     如此「建版 + 回填」要么同 COMMIT、要么同 ROLLBACK，绝不出现「已提交 version 但 item 无指针」窗口；
//     接管后重试据 candidate 重建（无残留半版，不重复建版）。
//   本套件直测缺口单元 structureCandidateItem（StructureFakeDb 模拟候选/证据/建体/受保护落库 + StructureFakeTxPool ROLLBACK 还原）：
//     · 正常：create→（同事务原子回填）→structure→ready（item 焊上 versionId，恰 1 cap / 1 version，7 软字段补齐）。
//     · 原子窗口（r7）：create-后-回填-前被接管 → 同事务回滚（version【未提交、未残留】）→ fencedOut → 重试重建恰 1 version（不重复建版）。
//     · 反向破坏：create 与回填【非原子】且 create【无幂等】（旧实现）→ 重试重复建版（versions.size===2）——守门断言「不应重复」会红。
import { describe, it, expect } from 'vitest';
import { SOFT_FIELD_KEYS } from '@cb/shared';
import {
  structureCandidateItem,
  type OnVersionCreatedInTx,
} from '../modules/publish/batch-structure.js';
import { createCapability } from '../modules/structure/create-capability.js';
import { StructureFakeDb, StructureFakeTxPool, StreamingFakeGateway } from './structure-fakes.js';

/** 内存 batch item 行的最小模型（仅本套件关心的列：version_id、capability_id）。 */
interface FakeItemRow {
  version_id: string | null;
  capability_id: string | null;
}

/** 播种一条 ready 候选 + 证据（create-capability sourceCandidateId 分支 + structure 直读证据所需）。 */
function seedCandidateWithEvidence(db: StructureFakeDb, candidateId: string, owner: string): void {
  db.candidates.set(candidateId, {
    id: candidateId,
    owner_user_id: owner,
    name: 'PRD 炼金师',
    slug: 'prd-alchemist',
    status: 'ready',
  });
  db.segments.set('seg1', {
    id: 'seg1',
    snapshot_id: 'snap1',
    title: '需求会话',
    source: 'doc',
    project: 'p1',
    content: '把零散需求整理成结构化 PRD，覆盖背景、目标、范围、验收标准。',
  });
  db.evidence.set('ev1', { id: 'ev1', candidate_id: candidateId, segment_id: 'seg1' });
}

function setup(): {
  db: StructureFakeDb;
  tx: StructureFakeTxPool;
  gateway: StreamingFakeGateway;
} {
  const db = new StructureFakeDb();
  return { db, tx: new StructureFakeTxPool(db), gateway: new StreamingFakeGateway() };
}

/** 起批 job（running, fence）：structureCandidateItem 受保护落库经此 fence 内联校验。 */
function startBatchJob(db: StructureFakeDb, jobId: string, owner: string, fence = 1): void {
  db.jobs.set(jobId, { id: jobId, status: 'running', owner_user_id: owner, fence_token: fence });
}

/**
 * 忠实模拟 backfillItemVersionInTx 语义的【同事务】回填钩子：受 create-capability 同 tx 调用、fence 经 job running/fence_token、
 *   仅 item 尚无 version_id 时回填（幂等防覆盖）。fence 失配/非 running → 0 行 → 返回 false → create-capability 抛 fenced 回滚整事务。
 */
function makeInTxBackfill(
  db: StructureFakeDb,
  item: FakeItemRow,
  jobId: string,
  fence: number,
): OnVersionCreatedInTx {
  return async (_tx, { versionId, capabilityId }) => {
    const j = db.jobs.get(jobId);
    if (!j || j.status !== 'running' || j.fence_token !== fence) return false; // fence out
    if (item.version_id) return true; // 幂等：已回填（不覆盖）。
    item.version_id = versionId;
    if (capabilityId) item.capability_id = capabilityId;
    return true;
  };
}

const OWNER = 'u1';
const CAND = 'cand-1';
const JOB = 'job-batch-1';

describe('B-29 批编排「已生成不丢 + 重试不重复建版」· create+回填同事务原子（r7 原子窗口守门）', () => {
  it('正常：create →（同事务原子回填）→ structure → ready（item 焊上 versionId，恰 1 cap/1 version，7 软字段补齐落库）', async () => {
    const { db, tx, gateway } = setup();
    seedCandidateWithEvidence(db, CAND, OWNER);
    startBatchJob(db, JOB, OWNER, 1);
    const item: FakeItemRow = { version_id: null, capability_id: null };

    const outcome = await structureCandidateItem(
      { db, txPool: tx, gateway },
      {
        candidateId: CAND,
        ownerUserId: OWNER,
        jobId: JOB,
        fenceToken: 1,
        traceId: 'tr',
        onVersionCreatedInTx: makeInTxBackfill(db, item, JOB, 1),
      },
    );

    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    // 原子回填：item 行焊上 create 出的 versionId（与建版同 COMMIT）。
    expect(item.version_id).toBe(outcome.versionId);
    // 只建一个 capability + 一个 version（无重复建体）。
    expect(db.capabilities.size).toBe(1);
    expect(db.versions.size).toBe(1);
    // 7 软字段已补齐进版本 manifest（structure 受保护落库一次）。
    const v = db.versions.get(outcome.versionId)!;
    const mf = v.manifest as Record<string, unknown>;
    for (const f of SOFT_FIELD_KEYS) {
      const val = mf[f];
      expect(Array.isArray(val) ? val.length > 0 : (val as string).length > 0).toBe(true);
    }
  });

  it('原子窗口（r7）：create-后-回填-前被接管（回填 0 行）→ 同事务回滚（version 未提交/未残留）→ fencedOut；重试重建【恰 1 version】（不重复建版）', async () => {
    const { db, tx, gateway } = setup();
    seedCandidateWithEvidence(db, CAND, OWNER);
    startBatchJob(db, JOB, OWNER, 1);
    const item: FakeItemRow = { version_id: null, capability_id: null };

    // 第一遍：建版同事务内、回填钩子被调时 job 已被接管换 fence=2 → 回填 0 行 → 钩子返 false → 整事务回滚（建版一并回滚）。
    const onVersionCreatedInTx: OnVersionCreatedInTx = async (_tx, _created) => {
      // 模拟「create 提交那一刻才发现已被接管」：钩子在建版同 tx 内执行，此时 fence 已翻动 → 回填守门 0 行。
      db.jobs.get(JOB)!.fence_token = 2;
      return false; // fence out → create-capability 抛 fenced，整事务（含建版 INSERT）回滚。
    };
    const first = await structureCandidateItem(
      { db, txPool: tx, gateway },
      {
        candidateId: CAND,
        ownerUserId: OWNER,
        jobId: JOB,
        fenceToken: 1,
        traceId: 'tr',
        onVersionCreatedInTx,
      },
    );
    expect(first.kind).toBe('fencedOut');
    // 关键（原子）：建版与回填同事务回滚 → 【绝无残留半版】（version/cap 未提交）、item 行也未焊 versionId。
    expect(db.versions.size).toBe(0);
    expect(db.capabilities.size).toBe(0);
    expect(item.version_id).toBeNull();

    // 第二遍（重试 / 新 attempt：换 fence=2 续跑）→ 据 candidate 重建恰 1 version（无第一遍残留可重复建版，已生成不丢的反面：未生成则诚实重建）。
    db.jobs.get(JOB)!.fence_token = 2;
    const retry = await structureCandidateItem(
      { db, txPool: tx, gateway },
      {
        candidateId: CAND,
        ownerUserId: OWNER,
        jobId: JOB,
        fenceToken: 2,
        traceId: 'tr',
        onVersionCreatedInTx: makeInTxBackfill(db, item, JOB, 2),
      },
    );

    expect(retry.kind).toBe('ready');
    if (retry.kind !== 'ready') return;
    // 重建恰 1 version（不重复建版：第一遍因原子回滚未残留任何版本）。
    expect(db.versions.size).toBe(1);
    expect(db.capabilities.size).toBe(1);
    expect(item.version_id).toBe(retry.versionId);
  });

  it('create 同 COMMIT 后再 structure 落库被接管 → fencedOut → 重试携 existingVersionId 复用既有版本续补，不重复建版', async () => {
    const { db, tx, gateway } = setup();
    seedCandidateWithEvidence(db, CAND, OWNER);
    startBatchJob(db, JOB, OWNER, 1);
    const item: FakeItemRow = { version_id: null, capability_id: null };

    // 第一遍：建版 + 回填同 COMMIT（fence 仍 1 → 回填成功、版本已焊到 item 行），随后【structure 落库前】被接管换 fence=2 → 落库 0 行 → fencedOut。
    const onVersionCreatedInTx: OnVersionCreatedInTx = async (tx, created) => {
      const ok = await makeInTxBackfill(db, item, JOB, 1)(tx, created);
      // 同事务回填成功（fence 仍 1）后，模拟接管换 fence=2 → structure 受保护落库随后命中 0 行 → fencedOut（版本已 COMMIT、已焊 item 行）。
      db.jobs.get(JOB)!.fence_token = 2;
      return ok;
    };
    const first = await structureCandidateItem(
      { db, txPool: tx, gateway },
      {
        candidateId: CAND,
        ownerUserId: OWNER,
        jobId: JOB,
        fenceToken: 1,
        traceId: 'tr',
        onVersionCreatedInTx,
      },
    );
    expect(first.kind).toBe('fencedOut');
    // 版本已建且【已回填 item 行】（建版+回填同 COMMIT，已生成不丢）。
    expect(item.version_id).not.toBeNull();
    const builtVersionId = item.version_id!;
    expect(db.versions.size).toBe(1);
    expect(db.capabilities.size).toBe(1);

    // 第二遍（重试 / 新 attempt：换 fence=2，携 item 行回填的 existingVersionId）→ 复用既有版本、跳过 create、续 structure → ready。
    const versBefore = db.versions.size;
    const capsBefore = db.capabilities.size;
    const retry = await structureCandidateItem(
      { db, txPool: tx, gateway },
      {
        candidateId: CAND,
        ownerUserId: OWNER,
        jobId: JOB,
        fenceToken: 2,
        traceId: 'tr',
        existingVersionId: builtVersionId,
        onVersionCreatedInTx: makeInTxBackfill(db, item, JOB, 2),
      },
    );

    expect(retry.kind).toBe('ready');
    if (retry.kind !== 'ready') return;
    expect(retry.versionId).toBe(builtVersionId); // 复用同版（不重复建版）。
    expect(db.versions.size).toBe(versBefore);
    expect(db.capabilities.size).toBe(capsBefore);
  });

  it('candidate 已有 draft version 但 item 未回填 → 重试按 source_candidate_id 复用同版，不重复建版', async () => {
    const { db, tx, gateway } = setup();
    seedCandidateWithEvidence(db, CAND, OWNER);
    startBatchJob(db, JOB, OWNER, 1);
    const item: FakeItemRow = { version_id: null, capability_id: null };

    // 模拟历史残留：create-capability 已建出 draft，但 item.version_id 因旧窗口未回填。
    const created1 = await createCapability(db, tx, { sourceCandidateId: CAND }, { userId: OWNER });
    expect(db.versions.size).toBe(1); // 版本已 COMMIT 残留。
    expect(item.version_id).toBeNull(); // 回填丢失（item 无指针）。

    // 重试：item 无 versionId → 不带 existingVersionId，但 prepareCandidateDraft 会按 source_candidate_id 找到同版复用。
    const retry = await structureCandidateItem(
      { db, txPool: tx, gateway },
      {
        candidateId: CAND,
        ownerUserId: OWNER,
        jobId: JOB,
        fenceToken: 1,
        traceId: 'tr',
        // 无 existingVersionId（item 未回填）、无 onVersionCreatedInTx（破坏：不原子回填）——重试必重复 create。
      },
    );
    expect(retry.kind).toBe('ready');
    if (retry.kind !== 'ready') return;
    expect(db.versions.size).toBe(1);
    expect(retry.versionId).toBe(created1.versionId);
  });
});
