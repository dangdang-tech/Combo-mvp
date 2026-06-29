// 00 · 草稿生命周期仓储（脊柱 §8，开工总纲 §5.0「每步可存草稿 + 断点续传」；Codex phase4c P0-2）。
//   草稿 bootstrap + 逐步推进（owner 守卫 + 单次写 + 幂等）：
//     · createDraft —— 新建一行 drafts(owner, status='active', current_step='import')，返回 draftId（fresh flow 续传基线）。
//     · backfillDraftSnapshot —— import 完成把 snapshot_id + current_step='extract' 焊到本草稿（导入产物落点）。
//     · backfillDraftExtract  —— extract 起把 extract_job_id + current_step='extract' 焊到本草稿（萃取落点）。
//     · backfillDraftBatch    —— 批量发布建批把 batch_id + current_step='publish' 焊到本草稿（批量发布落点）。
//     · readDraftView        —— 读完整 DraftView（step/selection/snapshot/extract/version/capability/batch + stepProgress）。
//   structure 步推进（version_id + capability_id + current_step='structure'）复用既有
//     structure-repo.backfillDraftInTx（建版同事务回填，§4.A）——本仓储不重复实现，关注点单一。
//   铁律：
//     · owner 守卫——每个回填 UPDATE 内联 owner_user_id + status='active'，杜绝覆盖他人/已终态草稿（Codex P0-2）。
//     · 单次写——每步一条 UPDATE 单语句改一行；rowCount=0 = 草稿不存在 / 非本人 / 非 active（调用方据此 403/404）。
//     · 幂等——回填只前进不回退（current_step 用 GREATEST 序号守门：已在更后的步不被早步覆写），重投/乱序安全。
//     · current_step 永不倒退（续传回精确断点，§8.4）：用步序数 step_rank 比较，仅当目标步 ≥ 当前步才推进 current_step。
import type { DraftStep, DraftStatus, DraftView } from '@cb/shared';

/**
 * 草稿仓储 DB 句柄最小面：仅依赖 query（pg.Pool / PoolClient / 事务句柄 Tx 子集通用）。
 *   rowCount 宽松可空（兼容 jobs/types.Queryable 的 number|null 与 events/db-tx.Tx 的 number|null|undefined），
 *   故回填可同时被 import worker 的事务句柄（Tx）与路由层 db（Queryable）调用，关注点单一不耦合具体连接类型。
 */
interface DraftDb {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** 五步枚举的序号（current_step 永不倒退守门：仅 ≥ 当前步才推进）。select 是纯前端步，无服务端回填。 */
const STEP_RANK: Record<DraftStep, number> = {
  import: 0,
  extract: 1,
  select: 2,
  structure: 3,
  publish: 4,
};

/** drafts 行（DraftView 所需列；与 60 dashboard-repo DraftRow 同口径，§8.4 DDL）。 */
interface DraftRow {
  id: string;
  status: string;
  current_step: string;
  step_progress: { percent?: number; phrase?: string } | null;
  title: string | null;
  snapshot_id: string | null;
  extract_job_id: string | null;
  selection: unknown;
  version_id: string | null;
  capability_id: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

/** drafts 行 → DraftView（落点引用按存在性收敛，不漏发 undefined 键；与 dashboard listDrafts 同映射）。 */
export function rowToDraftView(r: DraftRow): DraftView {
  const sp = r.step_progress ?? {};
  const view: DraftView = {
    id: r.id,
    status: r.status as DraftStatus,
    currentStep: r.current_step as DraftStep,
    stepProgress: {
      percent: typeof sp.percent === 'number' ? sp.percent : 0,
      phrase: typeof sp.phrase === 'string' ? sp.phrase : '',
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.title !== null) view.title = r.title;
  if (r.snapshot_id !== null) view.snapshotId = r.snapshot_id;
  if (r.extract_job_id !== null) view.extractJobId = r.extract_job_id;
  if (r.selection !== null && r.selection !== undefined) view.selection = r.selection;
  if (r.version_id !== null) view.versionId = r.version_id;
  if (r.capability_id !== null) view.capabilityId = r.capability_id;
  if (r.batch_id !== null) view.batchId = r.batch_id;
  return view;
}

const DRAFT_SELECT_COLS = `id, status, current_step, step_progress, title,
            snapshot_id, extract_job_id, selection, version_id, capability_id, batch_id,
            created_at::text AS created_at, updated_at::text AS updated_at`;

// ===========================================================================
// bootstrap：新建一行草稿（fresh flow 续传基线）
// ===========================================================================

/**
 * 新建一行草稿（草稿 bootstrap，§8）。owner=本人（路由层已鉴权 creator），status='active'、current_step='import'。
 *   返回完整 DraftView（含 draftId）——前端拿 draftId 贯穿后续 snapshot/extract/version/capability/batch 全部回填同一 draft。
 *   title 可选（草稿条可读标题区分多条，§8.4）；缺省 NULL（前端可后续据导入/能力名补）。
 *   幂等回放由路由 preHandler requireIdempotency(draft.create) 兜（重复点新建回放同一 draftId，不重复建行）。
 */
export async function createDraft(
  db: DraftDb,
  args: { ownerUserId: string; title?: string },
): Promise<DraftView> {
  const res = await db.query<DraftRow>(
    `INSERT INTO drafts (owner_user_id, status, current_step, title)
     VALUES ($1, 'active', 'import', $2)
     RETURNING ${DRAFT_SELECT_COLS}`,
    [args.ownerUserId, args.title ?? null],
  );
  return rowToDraftView(res.rows[0]!);
}

// ===========================================================================
// 读完整 DraftView（续传 hydrate + 回填后回放）
// ===========================================================================

/**
 * 读完整 DraftView（§8.4 续传）。owner 守卫：仅本人 + active 草稿可读（非本人/不存在 → null，不暴露存在性，10-auth §6.3）。
 *   completed/abandoned 草稿不上条（§1.5），故按 active 收敛；调用方据 null → 404。
 */
export async function readDraftView(
  db: DraftDb,
  args: { draftId: string; ownerUserId: string },
): Promise<DraftView | null> {
  const res = await db.query<DraftRow>(
    `SELECT ${DRAFT_SELECT_COLS}
       FROM drafts
      WHERE id = $1 AND owner_user_id = $2 AND status = 'active'`,
    [args.draftId, args.ownerUserId],
  );
  return res.rows[0] ? rowToDraftView(res.rows[0]) : null;
}

// ===========================================================================
// 逐步推进回填（owner 守卫 + 单次写 + current_step 永不倒退）
// ===========================================================================

/**
 * current_step 永不倒退的推进表达式：仅当目标步序 ≥ 当前步序才用目标步，否则保留当前步（续传回精确断点，§8.4）。
 *   SQL 内联（CASE WHEN step_rank(current_step) <= targetRank THEN target ELSE current_step）——避免重投/乱序把已到更后的步打回。
 */
function advanceStepSql(targetStep: DraftStep, targetParam: string): string {
  const targetRank = STEP_RANK[targetStep];
  const ranks = Object.entries(STEP_RANK)
    .map(([s, r]) => `WHEN '${s}' THEN ${r}`)
    .join(' ');
  return `CASE WHEN (CASE current_step ${ranks} ELSE 0 END) <= ${targetRank}
               THEN ${targetParam} ELSE current_step END`;
}

/** 回填结果：是否命中（rowCount>0）。0 行 = 草稿不存在 / 非本人 / 非 active（owner 守卫拦下）。 */
async function backfillStep(
  db: DraftDb,
  args: {
    draftId: string;
    ownerUserId: string;
    setClause: string;
    setParams: unknown[];
  },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE drafts
        SET ${args.setClause}, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status = 'active'`,
    [args.draftId, args.ownerUserId, ...args.setParams],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * import 完成：把 snapshot_id 焊到本草稿 + 推进 current_step → 'extract'（导入产物落点，续传回萃取步）。
 *   owner 守卫 + 单次写；current_step 永不倒退（已过萃取/结构化的草稿不被打回）。
 *   幂等：重投同 snapshotId 再写一次安全（COALESCE 保护可选，但 import 单快照、直接置即可——重投值同，无害）。
 */
export async function backfillDraftSnapshot(
  db: DraftDb,
  args: { draftId: string; ownerUserId: string; snapshotId: string },
): Promise<boolean> {
  return backfillStep(db, {
    draftId: args.draftId,
    ownerUserId: args.ownerUserId,
    setClause: `snapshot_id = $3, current_step = ${advanceStepSql('extract', "'extract'")}`,
    setParams: [args.snapshotId],
  });
}

/**
 * extract 起：把 extract_job_id 焊到本草稿 + 推进 current_step → 'extract'（萃取落点，续传回萃取步在跑的 job）。
 *   owner 守卫 + 单次写；current_step 永不倒退。
 *   注（Codex r4 P0）：生产触发萃取路径已改为【建 extract job 同一条 CTE 内同事务回填】（见
 *     extract/create-extract-job.insertFullExtractJob），续传指针绝不与 job 半落。本函数保留为通用草稿落点写原语
 *     （owner 守卫语义与同事务回填一致），供仓储/测试复用，不在触发萃取热路径上独立调用。
 */
export async function backfillDraftExtract(
  db: DraftDb,
  args: { draftId: string; ownerUserId: string; extractJobId: string },
): Promise<boolean> {
  return backfillStep(db, {
    draftId: args.draftId,
    ownerUserId: args.ownerUserId,
    setClause: `extract_job_id = $3, current_step = ${advanceStepSql('extract', "'extract'")}`,
    setParams: [args.extractJobId],
  });
}

/**
 * 批量发布建批：把 batch_id 焊到本草稿 + 推进 current_step → 'publish'（批量发布落点，续传回批进度）。
 *   owner 守卫 + 单次写；current_step 永不倒退。
 */
export async function backfillDraftBatch(
  db: DraftDb,
  args: { draftId: string; ownerUserId: string; batchId: string },
): Promise<boolean> {
  return backfillStep(db, {
    draftId: args.draftId,
    ownerUserId: args.ownerUserId,
    setClause: `batch_id = $3, current_step = ${advanceStepSql('publish', "'publish'")}`,
    setParams: [args.batchId],
  });
}
