// 00 · 草稿生命周期仓储自检（脊柱 §8，开工总纲 §5.0；Codex phase4c P0-2）。忠实假 PG，无真 PG。
//   重点（铁律）：
//     · createDraft —— 建 active/import 行，返回完整 DraftView（含 draftId）。
//     · 逐步推进回填（snapshot/extract）—— owner 守卫（非本人/不存在/非 active → 0 行不命中）、单次写、
//       current_step 永不倒退（已到更后步不被早步打回）、幂等（重投同值安全）。
//     · readDraftView —— 完整读（step/selection/snapshot/extract/version/capability + stepProgress）；
//       owner 守卫（非本人/非 active → null）。
//   反向破坏：非本人回填 → 0 行（不命中、不串台）；structure 步后再 import 回填 → current_step 不退回 import。
import { describe, it, expect } from 'vitest';
import {
  createDraft,
  readDraftView,
  backfillDraftSnapshot,
  backfillDraftExtract,
} from '../modules/drafts/repo.js';

interface DraftRowF {
  id: string;
  owner_user_id: string;
  status: string;
  current_step: string;
  step_progress: { percent?: number; phrase?: string } | null;
  title: string | null;
  snapshot_id: string | null;
  extract_job_id: string | null;
  selection: unknown;
  version_id: string | null;
  capability_id: string | null;
  created_at: string;
  updated_at: string;
}

const STEP_RANK: Record<string, number> = {
  import: 0,
  extract: 1,
  select: 2,
  structure: 3,
  publish: 4,
};

let seq = 0;

/** 忠实假 PG（drafts 单表）：INSERT RETURNING、owner+active 守卫 SELECT、owner+active 守卫 UPDATE（current_step 不倒退）。 */
class DraftsFakeDb {
  rows = new Map<string, DraftRowF>();
  /** 每条 UPDATE 影响行数历史（断言「单次写、命中/未命中」）。 */
  updateRowCounts: number[] = [];

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    // INSERT INTO drafts ... RETURNING（bootstrap）。
    if (sql.includes('INSERT INTO drafts') && sql.includes('RETURNING')) {
      seq += 1;
      const id = `draft-${seq}`;
      const now = new Date(1781600000000 + seq * 1000).toISOString();
      const row: DraftRowF = {
        id,
        owner_user_id: params[0] as string,
        status: 'active',
        current_step: 'import',
        step_progress: {},
        title: (params[1] as string | null) ?? null,
        snapshot_id: null,
        extract_job_id: null,
        selection: null,
        version_id: null,
        capability_id: null,
        created_at: now,
        updated_at: now,
      };
      this.rows.set(id, row);
      return { rows: [this.selectShape(row)] as R[], rowCount: 1 };
    }

    // SELECT ... FROM drafts WHERE id+owner+active（readDraftView）。
    if (
      sql.includes('FROM drafts') &&
      sql.includes('WHERE id = $1 AND owner_user_id = $2') &&
      sql.includes("status = 'active'") &&
      sql.trimStart().startsWith('SELECT')
    ) {
      const r = this.rows.get(params[0] as string);
      if (!r || r.owner_user_id !== params[1] || r.status !== 'active') {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [this.selectShape(r)] as R[], rowCount: 1 };
    }

    // UPDATE drafts SET ... WHERE id+owner+active（逐步推进回填）。
    if (
      sql.includes('UPDATE drafts') &&
      sql.includes('WHERE id = $1 AND owner_user_id = $2') &&
      sql.includes("status = 'active'")
    ) {
      const r = this.rows.get(params[0] as string);
      // owner 守卫：不存在 / 非本人 / 非 active → 0 行。
      if (!r || r.owner_user_id !== params[1] || r.status !== 'active') {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      // 解析 SET 子句的落点列 + current_step 永不倒退（忠实模拟 CASE WHEN rank<=target THEN target ELSE current）。
      const p3 = params[2];
      if (sql.includes('snapshot_id = $3')) {
        r.snapshot_id = p3 as string;
        this.advanceStep(r, 'extract');
      } else if (sql.includes('extract_job_id = $3')) {
        r.extract_job_id = p3 as string;
        this.advanceStep(r, 'extract');
      }
      r.updated_at = new Date(Date.now()).toISOString();
      this.updateRowCounts.push(1);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`DraftsFakeDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  /** current_step 永不倒退：仅当目标步序 ≥ 当前步序才推进。 */
  private advanceStep(r: DraftRowF, target: string): void {
    if (STEP_RANK[r.current_step]! <= STEP_RANK[target]!) r.current_step = target;
  }

  private selectShape(r: DraftRowF): Record<string, unknown> {
    return {
      id: r.id,
      status: r.status,
      current_step: r.current_step,
      step_progress: r.step_progress,
      title: r.title,
      snapshot_id: r.snapshot_id,
      extract_job_id: r.extract_job_id,
      selection: r.selection,
      version_id: r.version_id,
      capability_id: r.capability_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  /** 测试辅助：直接置某草稿的 current_step（模拟已推进到更后步）。 */
  setStep(id: string, step: string): void {
    const r = this.rows.get(id);
    if (r) r.current_step = step;
  }
  /** 测试辅助：直接落 structure 步产物（模拟 create-capability backfillDraftInTx 已回填）。 */
  setStructure(id: string, versionId: string, capabilityId: string): void {
    const r = this.rows.get(id);
    if (r) {
      r.version_id = versionId;
      r.capability_id = capabilityId;
      r.current_step = 'structure';
      r.selection = { mode: 'single', candidateId: 'cand-x' };
    }
  }
}

const OWNER = 'user-me';
const OTHER = 'user-other';

describe('drafts-repo · bootstrap createDraft（§8）', () => {
  it('新建 active/import 草稿，返回完整 DraftView（含 draftId）', async () => {
    const db = new DraftsFakeDb();
    const view = await createDraft(db, { ownerUserId: OWNER, title: '我的第一个能力' });
    expect(view.id).toBeTruthy();
    expect(view.status).toBe('active');
    expect(view.currentStep).toBe('import');
    expect(view.title).toBe('我的第一个能力');
    expect(view.stepProgress).toEqual({ percent: 0, phrase: '' });
    // 落点引用初始全空（按存在性收敛，不漏发 undefined 键）。
    expect(view.snapshotId).toBeUndefined();
    expect(view.extractJobId).toBeUndefined();
    expect(view.versionId).toBeUndefined();
  });

  it('title 缺省 → NULL（DraftView 不带 title 键）', async () => {
    const db = new DraftsFakeDb();
    const view = await createDraft(db, { ownerUserId: OWNER });
    expect(view.title).toBeUndefined();
  });
});

describe('drafts-repo · 逐步推进回填（owner 守卫 + 单次写 + current_step 永不倒退）', () => {
  it('import → snapshot 回填：snapshotId 焊上 + current_step 进 extract（本人命中、单次写）', async () => {
    const db = new DraftsFakeDb();
    const draft = await createDraft(db, { ownerUserId: OWNER });
    const ok = await backfillDraftSnapshot(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      snapshotId: 'snap-1',
    });
    expect(ok).toBe(true);
    expect(db.updateRowCounts).toEqual([1]); // 单次写、命中一行。
    const view = await readDraftView(db, { draftId: draft.id, ownerUserId: OWNER });
    expect(view?.snapshotId).toBe('snap-1');
    expect(view?.currentStep).toBe('extract');
  });

  it('extract 回填：extractJobId 焊上 + current_step extract（续传回在跑的 job）', async () => {
    const db = new DraftsFakeDb();
    const draft = await createDraft(db, { ownerUserId: OWNER });
    await backfillDraftSnapshot(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      snapshotId: 'snap-1',
    });
    const ok = await backfillDraftExtract(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      extractJobId: 'job-extract-1',
    });
    expect(ok).toBe(true);
    const view = await readDraftView(db, { draftId: draft.id, ownerUserId: OWNER });
    expect(view?.extractJobId).toBe('job-extract-1');
    expect(view?.currentStep).toBe('extract');
  });

  it('owner 守卫（反向破坏）：非本人回填 → 0 行不命中、不串台（草稿 current_step/落点不变）', async () => {
    const db = new DraftsFakeDb();
    const draft = await createDraft(db, { ownerUserId: OWNER });
    const ok = await backfillDraftSnapshot(db, {
      draftId: draft.id,
      ownerUserId: OTHER, // 非本人
      snapshotId: 'snap-evil',
    });
    expect(ok).toBe(false);
    expect(db.updateRowCounts).toEqual([0]); // 未命中。
    // 本人读：草稿仍 import、无 snapshot（他人写未生效，无连坐、不串台）。
    const view = await readDraftView(db, { draftId: draft.id, ownerUserId: OWNER });
    expect(view?.currentStep).toBe('import');
    expect(view?.snapshotId).toBeUndefined();
  });

  it('current_step 永不倒退（反向破坏）：草稿已到 publish，迟到的 import→snapshot 回填不把 current_step 打回 extract', async () => {
    const db = new DraftsFakeDb();
    const draft = await createDraft(db, { ownerUserId: OWNER });
    db.setStep(draft.id, 'publish'); // 已推进到发布步。
    const ok = await backfillDraftSnapshot(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      snapshotId: 'snap-late',
    });
    expect(ok).toBe(true); // 仍命中（owner+active），但 current_step 不倒退。
    const view = await readDraftView(db, { draftId: draft.id, ownerUserId: OWNER });
    expect(view?.currentStep).toBe('publish'); // 永不倒退（续传回精确断点）。
    expect(view?.snapshotId).toBe('snap-late'); // 落点仍焊上（已生成不丢）。
  });

  it('幂等：同 snapshotId 重投两次安全（值相同、各命中一行、终态一致）', async () => {
    const db = new DraftsFakeDb();
    const draft = await createDraft(db, { ownerUserId: OWNER });
    await backfillDraftSnapshot(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      snapshotId: 'snap-1',
    });
    await backfillDraftSnapshot(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      snapshotId: 'snap-1',
    });
    const view = await readDraftView(db, { draftId: draft.id, ownerUserId: OWNER });
    expect(view?.snapshotId).toBe('snap-1');
    expect(view?.currentStep).toBe('extract');
  });
});

describe('drafts-repo · readDraftView 完整读（续传 hydrate）', () => {
  it('完整落点全读出（snapshot/extract/version/capability + selection + step）', async () => {
    const db = new DraftsFakeDb();
    const draft = await createDraft(db, { ownerUserId: OWNER });
    await backfillDraftSnapshot(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      snapshotId: 'snap-1',
    });
    await backfillDraftExtract(db, {
      draftId: draft.id,
      ownerUserId: OWNER,
      extractJobId: 'job-x',
    });
    db.setStructure(draft.id, 'ver-1', 'cap-1'); // structure 步产物（create-capability 已回填）。

    const view = await readDraftView(db, { draftId: draft.id, ownerUserId: OWNER });
    expect(view).toMatchObject({
      id: draft.id,
      status: 'active',
      currentStep: 'structure',
      snapshotId: 'snap-1',
      extractJobId: 'job-x',
      versionId: 'ver-1',
      capabilityId: 'cap-1',
    });
    expect(view?.selection).toEqual({ mode: 'single', candidateId: 'cand-x' });
  });

  it('owner 守卫：非本人读 → null（不暴露存在性）', async () => {
    const db = new DraftsFakeDb();
    const draft = await createDraft(db, { ownerUserId: OWNER });
    const view = await readDraftView(db, { draftId: draft.id, ownerUserId: OTHER });
    expect(view).toBeNull();
  });

  it('不存在草稿读 → null', async () => {
    const db = new DraftsFakeDb();
    const view = await readDraftView(db, { draftId: 'nope', ownerUserId: OWNER });
    expect(view).toBeNull();
  });
});
