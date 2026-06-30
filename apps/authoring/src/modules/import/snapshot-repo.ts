// B-19 · 快照 / 段落仓储（20-step1-import §6.1/§6.2/§6.5）。
//   两组职责，全部注入 Queryable（pg 子集），便于 mock 单测、无真 PG：
//     ① 受保护写入（worker import handler 用）：建快照 / 写段 / 把原文清弃标记，
//        fence 校验【内联进单条事务 CTE 的数据源 jobs】（§11.A，禁两步「查+写」）。
//        重导永远 INSERT 新 raw_snapshots（绝不 UPDATE 旧），旧快照保留、superseded_by 指向新行（导入-21）。
//        段写入 ON CONFLICT (snapshot_id, content_hash) DO NOTHING（快照内去重，导入-22）。
//     ② 只读查询（api 快照端点用）：快照统计四格 + 去敏报告、会话节选 cursor 分页、用户快照列表。
//        owner 校验内联进 WHERE（非属主/不存在 → 0 行 → 调用方 404，不暴露存在性，10-auth §6.3）。
// 硬约束：段正文/标题是去敏后内容（隐私已抹，导入-30），本仓储只搬运、不再去敏（去敏在 handler 的 redact 子任务）。
import type {
  ImportSource,
  RedactionReportView,
  SnapshotView,
  SnapshotSegmentView,
  SnapshotListItem,
} from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx } from '../../platform/events/db-tx.js';

/** 受保护建快照入参（§6.5 模板②；fence 经 jobs 内联校验）。 */
export interface InsertSnapshotArgs {
  jobId: string;
  fenceToken: number;
  source: ImportSource;
  sources: readonly Exclude<ImportSource, 'mixed'>[];
  rawS3Key: string | null;
  segmentCount: number;
  messageCount: number;
  projectCount: number;
  /** 时间跨度（'YYYY-MM-DD' 起/止；空快照应被 handler 拦在 IMPORT_NO_CONTENT，不到此处）。 */
  timeFrom: string | null;
  timeTo: string | null;
  redactionReport: RedactionReportView;
  rulesetVersion: string;
}

/** 受保护写段入参（§6.5 模板③；fence 经 snapshot→job 联表内联校验）。 */
export interface InsertSegmentArgs {
  snapshotId: string;
  fenceToken: number;
  contentHash: string;
  source: Exclude<ImportSource, 'mixed'>;
  title: string;
  dateLabel: string;
  happenedAt: string | null;
  project: string | null;
  messageCount: number;
  content: string;
}

/** 写段结果：inserted=false 即被去重静默跳过（快照内重复，导入-22）或被 fence out（0 行）。 */
export interface InsertSegmentResult {
  /** DB 生成的 segment id（仅 inserted=true 有值；前端 item-appended 据此点亮）。 */
  segmentId: string | null;
  inserted: boolean;
  /** 0 行的原因区分：'fenced_out' = snapshot/job fence 不匹配；'duplicate' = 快照内 content_hash 已存在。 */
  reason?: 'fenced_out' | 'duplicate';
}

/**
 * 受保护建快照（§11.A 模板②，受保护 INSERT）。
 *   fence 校验内联进数据源 `jobs WHERE id AND fence_token AND status='running'`：
 *   被 fence out（取消/重入队换 fence）→ SELECT 无行 → INSERT 0 行 → 返回 null，handler 安全退出（不建快照）。
 *   owner_user_id / import_job_id 取自 jobs 行（血缘焊死，不靠入参传 owner，杜绝越权写）。
 */
export async function insertSnapshotProtected(
  db: Queryable,
  args: InsertSnapshotArgs,
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO raw_snapshots (
        id, owner_user_id, import_job_id, source, sources, raw_s3_key,
        segment_count, message_count, project_count, time_span_from, time_span_to,
        redaction_report, redaction_ruleset_ver
     )
     SELECT
        gen_uuid_v7(), j.owner_user_id, j.id, $3, $4::text[], $5,
        $6, $7, $8, $9::date, $10::date,
        $11::jsonb, $12
     FROM jobs j
     WHERE j.id = $1 AND j.fence_token = $2 AND j.status = 'running'
     RETURNING id`,
    [
      args.jobId,
      args.fenceToken,
      args.source,
      args.sources,
      args.rawS3Key,
      args.segmentCount,
      args.messageCount,
      args.projectCount,
      args.timeFrom,
      args.timeTo,
      JSON.stringify(args.redactionReport),
      args.rulesetVersion,
    ],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * 重导血缘焊接（导入-21 / 贯穿-21）：把该用户【此快照之前】仍 latest（superseded_by IS NULL）的旧快照
 *   全部 superseded_by ← 新快照 id。旧快照不删、其段与基于旧快照的提取结果保留可查、isLatest 变 false。
 *   **fence/status 守门（Codex P1-r3）**：血缘归并必须经【赢家 fence】把关——以新快照的 import_job_id → jobs 联表内联校验
 *     `j.fence_token = $3 AND j.status = 'running'`，唯有当前 fence 命中且 job 仍 running 时才动血缘。
 *     取消 / fence-out / 已完成（status≠running）路径下 guard 命中 0 行 → 不更新任何旧快照 superseded_by（取消不污染血缘）。
 *   调用方须把本 UPDATE 放进【最终业务状态 + outbox 同一事务】内（见 handlers/import.ts），整事务回滚则血缘也回滚（原子）。
 *   仅作用于本 owner、且排除新快照自身。返回被接替的旧快照数（对账/测试断言）。
 */
export async function supersedePriorSnapshots(
  // Tx（= QueryableDb，rowCount 可选）以兼容【收尾同事务 tx】调用方；Queryable（rowCount 必填）是其子类型，单测可直接传 ImportFakeDb。
  db: Tx,
  newSnapshotId: string,
  ownerUserId: string,
  jobId: string,
  fenceToken: number,
): Promise<number> {
  // guard：以新快照的 import_job_id → jobs 联表内联校验 fence + running（赢家 fence 才动血缘）。
  //   guard 0 行（取消/接管换 fence/已离开 running）→ FROM 无行 → UPDATE 0 行（绝不污染血缘）。
  const res = await db.query(
    `WITH guard AS (
        SELECT j.id
          FROM jobs j
         WHERE j.id = $4
           AND j.fence_token = $3
           AND j.status = 'running'
     )
     UPDATE raw_snapshots s
        SET superseded_by = $1
       FROM guard
      WHERE s.owner_user_id = $2
        AND s.id <> $1
        AND s.superseded_by IS NULL`,
    [newSnapshotId, ownerUserId, fenceToken, jobId],
  );
  return res.rowCount ?? 0;
}

/**
 * 受保护写一段（§11.A 模板③联表变体）。fence 经 `snapshot_id → raw_snapshots.import_job_id → jobs` 联表内联：
 *   - 非本 fence（取消/接管换了 fence）→ JOIN 命中 0 行 → INSERT 0 行 → reason='fenced_out'。
 *   - 快照内 content_hash 已存在 → ON CONFLICT DO NOTHING → RETURNING 无行 → reason='duplicate'（导入-22，照常完成不报错）。
 *   - 成功 → 返回 DB 生成的 segmentId。
 * 注意：用 INSERT...SELECT FROM 联表（而非两步），fence 与数据源同一条 SQL，无 TOCTOU（§11.A 铁律）。
 */
export async function insertSegmentProtected(
  db: Queryable,
  args: InsertSegmentArgs,
): Promise<InsertSegmentResult> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO session_segments (
        snapshot_id, content_hash, source, title, date_label, happened_at, project, message_count, content
     )
     SELECT
        s.id, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10
     FROM raw_snapshots s
     JOIN jobs j ON j.id = s.import_job_id
     WHERE s.id = $1
       AND j.fence_token = $2
       AND j.status = 'running'
     ON CONFLICT (snapshot_id, content_hash) DO NOTHING
     RETURNING id`,
    [
      args.snapshotId,
      args.fenceToken,
      args.contentHash,
      args.source,
      args.title,
      args.dateLabel,
      args.happenedAt,
      args.project,
      args.messageCount,
      args.content,
    ],
  );
  const id = res.rows[0]?.id;
  if (id) return { segmentId: id, inserted: true };
  // 0 行：区分「被 fence out」vs「快照内重复」。查快照是否仍在本 fence 下可写（轻查，仅控制流分类，非写入）。
  const live = await db.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM raw_snapshots s
       JOIN jobs j ON j.id = s.import_job_id
      WHERE s.id = $1 AND j.fence_token = $2 AND j.status = 'running'`,
    [args.snapshotId, args.fenceToken],
  );
  const stillLive = (live.rowCount ?? 0) > 0;
  return { segmentId: null, inserted: false, reason: stillLive ? 'duplicate' : 'fenced_out' };
}

/**
 * 原文清弃标记（导入-33 数据生命周期）：worker 处理完原文后标 raw_purged_at（正式盘只留去敏段）。
 *   受保护——仅对本 fence 下的快照标记（同一 attempt 产出的快照）。实际 S3 删对象由 sweeper orphan 清理驱动。
 */
export async function markRawPurgedProtected(
  db: Queryable,
  snapshotId: string,
  fenceToken: number,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE raw_snapshots s
        SET raw_purged_at = now()
       FROM jobs j
      WHERE s.id = $1
        AND j.id = s.import_job_id
        AND j.fence_token = $2
        AND j.status = 'running'`,
    [snapshotId, fenceToken],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 只读查询（api 快照端点；owner 内联，越权/不存在 → 0 行 → 调用方 404）
// ---------------------------------------------------------------------------

/** raw_snapshots 行（只读取展示所需列）。 */
interface SnapshotRow {
  id: string;
  owner_user_id: string;
  source: string;
  sources: string[];
  segment_count: number;
  message_count: number;
  project_count: number;
  time_span_from: string | null;
  time_span_to: string | null;
  redaction_report: unknown;
  created_at: string;
  superseded_by: string | null;
}

/** 去敏报告兜底：DB 存的是 RedactionReportView 聚合形态；缺/坏时回「已生效、零计数」（绝不裸转、不泄明文）。 */
function normalizeRedaction(raw: unknown): RedactionReportView {
  const r = (raw ?? {}) as Partial<RedactionReportView>;
  return {
    applied: true,
    totalRedactions: typeof r.totalRedactions === 'number' ? r.totalRedactions : 0,
    byCategory: Array.isArray(r.byCategory) ? r.byCategory : [],
    rulesetVersion: typeof r.rulesetVersion === 'string' ? r.rulesetVersion : 'unknown',
  };
}

function rowToSnapshotView(r: SnapshotRow): SnapshotView {
  const timeSpan =
    r.time_span_from && r.time_span_to ? { from: r.time_span_from, to: r.time_span_to } : null;
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    source: r.source as ImportSource,
    sources: r.sources as ImportSource[],
    stats: {
      segmentCount: r.segment_count,
      messageCount: r.message_count,
      timeSpan,
      projectCount: r.project_count,
    },
    redaction: normalizeRedaction(r.redaction_report),
    createdAt: r.created_at,
    supersededBySnapshotId: r.superseded_by,
  };
}

/**
 * GET /snapshots/{id}：快照统计四格 + 去敏报告（§5.1）。owner 内联守门：
 *   不存在 / 非属主 → 返回 null（调用方 404，不暴露存在性，导入-17）。
 */
export async function getSnapshotForOwner(
  db: Queryable,
  snapshotId: string,
  ownerUserId: string,
): Promise<SnapshotView | null> {
  const res = await db.query<SnapshotRow>(
    `SELECT id, owner_user_id, source, sources,
            segment_count, message_count, project_count,
            time_span_from::text AS time_span_from, time_span_to::text AS time_span_to,
            redaction_report, created_at, superseded_by
       FROM raw_snapshots
      WHERE id = $1 AND owner_user_id = $2`,
    [snapshotId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? rowToSnapshotView(row) : null;
}

/** 会话节选行（去敏后内容；节选只读，导入-15/16）。 */
interface SegmentRow {
  id: string;
  date_label: string | null;
  title: string | null;
  message_count: number;
  project: string | null;
}

function rowToSegmentView(r: SegmentRow): SnapshotSegmentView {
  return {
    segmentId: r.id,
    dateLabel: r.date_label ?? '',
    title: r.title ?? '',
    messageCount: r.message_count,
    ...(r.project ? { project: r.project } : {}),
    readOnly: true,
  };
}

export interface ListSegmentsParams {
  snapshotId: string;
  ownerUserId: string;
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}
export interface ListSegmentsResult {
  items: SnapshotSegmentView[];
  nextCursor: string | null;
  /** 快照存在且属主（用于区分「空快照」与「越权/不存在」→ 后者 404）。 */
  ownsSnapshot: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /snapshots/{id}/segments：会话节选 cursor 分页（§5.2，按 happened_at order，默认 desc，不返 total）。
 *   先验属主（owner 内联）——非属主/不存在 → ownsSnapshot=false（调用方 404）。
 *   cursor 用 segment id（UUID v7 时间有序，与 happened_at 大体同序）作不透明锚；多取一条判 hasMore。
 */
export async function listSnapshotSegments(
  db: Queryable,
  params: ListSegmentsParams,
): Promise<ListSegmentsResult> {
  // 属主校验（轻查；不存在/非属主即拒，不暴露存在性）。
  const own = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM raw_snapshots WHERE id = $1 AND owner_user_id = $2`,
    [params.snapshotId, params.ownerUserId],
  );
  if ((own.rowCount ?? 0) === 0) return { items: [], nextCursor: null, ownsSnapshot: false };

  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const order = params.order ?? 'desc';
  const conds = ['snapshot_id = $1'];
  const args: unknown[] = [params.snapshotId];
  if (params.cursor) {
    args.push(params.cursor);
    conds.push(order === 'desc' ? `id < $${args.length}` : `id > $${args.length}`);
  }
  args.push(limit + 1);
  const res = await db.query<SegmentRow>(
    `SELECT id, date_label, title, message_count, project
       FROM session_segments
      WHERE ${conds.join(' AND ')}
      ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $${args.length}`,
    args,
  );
  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
  return { items: page.map(rowToSegmentView), nextCursor, ownsSnapshot: true };
}

/** 用户快照列表行。 */
interface SnapshotListRow {
  id: string;
  source: string;
  segment_count: number;
  created_at: string;
  superseded_by: string | null;
}

function rowToListItem(r: SnapshotListRow): SnapshotListItem {
  return {
    id: r.id,
    source: r.source as ImportSource,
    segmentCount: r.segment_count,
    createdAt: r.created_at,
    isLatest: r.superseded_by === null, // 未被接替 = 最新（导入-21）
    supersededBySnapshotId: r.superseded_by,
  };
}

export interface ListSnapshotsParams {
  ownerUserId: string;
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}
export interface ListSnapshotsResult {
  items: SnapshotListItem[];
  nextCursor: string | null;
}

/**
 * GET /snapshots：当前用户快照列表（§5.3，重导后旧快照仍在列表、isLatest=false，导入-21/贯穿-21）。
 *   cursor 用 id（UUID v7 时间有序）；默认 desc（最新在前）。
 */
export async function listOwnerSnapshots(
  db: Queryable,
  params: ListSnapshotsParams,
): Promise<ListSnapshotsResult> {
  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const order = params.order ?? 'desc';
  const conds = ['owner_user_id = $1'];
  const args: unknown[] = [params.ownerUserId];
  if (params.cursor) {
    args.push(params.cursor);
    conds.push(order === 'desc' ? `id < $${args.length}` : `id > $${args.length}`);
  }
  args.push(limit + 1);
  const res = await db.query<SnapshotListRow>(
    `SELECT id, source, segment_count, created_at, superseded_by
       FROM raw_snapshots
      WHERE ${conds.join(' AND ')}
      ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $${args.length}`,
    args,
  );
  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
  return { items: page.map(rowToListItem), nextCursor };
}
