// B-19 · 导入 Job handler（注册为 3A runner 的 import JobHandler）。
//   阶段 B 云端解析去敏：worker 从 S3 拉原文 → 解析(B-18) → 去敏(B-17) → 切段 → 建 raw_snapshots(新快照)
//   → 写 session_segments(快照内 (snapshot_id,content_hash) 去重) → 同事务 emit outbox(import 完成→通知)。
//
// 五项子任务依次点亮（永不裸转圈，导入-08；标准序见 SUBTASK_SEQUENCES.import / §4.2）：
//   credential   连接凭证          —— 校验 S3 可达 + subject_ref 完整
//   fetch_index  拉取会话索引      —— 列原文对象、逐个 getObject 拉回（量化文案：已拉 X/Y 个文件）
//   redact       导入消息并抹掉隐私 —— 解析 + 逐段去敏（B-17/B-18）
//   segment      切分成段落        —— 去敏后内容 content_hash 重算 + 快照内去重 + 重算统计四格
//   snapshot     生成原始数据      —— 建快照 + 边写段边 item-appended（已生成不丢）+ 血缘归并 + 同事务发通知
//
// 三条硬规则落地：
//   ① 永不裸转圈：每步经 ctx.reportSubtask/reportProgress 推「子任务+量化文案」；边写段边 appendItem（导入-09）。
//   ② 绝不裸露错误码：空结果抛 { code: IMPORT_NO_CONTENT }（runner 归一人话信封，导入-20）；
//      S3/解析异常抛 DEPENDENCY_UNAVAILABLE/INTERNAL，绝不裸 ECONNRESET/堆栈（导入-18）。
//   ③ 已生成不丢：段经受保护 fence CTE 逐条落库（snapshot_repo）；取消/接管换 fence → 写 0 行干净退出，已落段保留（导入-35）。
//
// 受保护写入铁律（§11.A）：建快照/写段/标清弃全走 snapshot_repo 的 fence CTE（fence 内联进数据源 jobs）。
//   ctx.appendItem 自身也是受保护持久化（runner 内 persistProgress 带 fence）；fence 失配会抛 FencedOutError，runner 兜。
import {
  ErrorCode,
  SUBTASK_SEQUENCES,
  redactBatch,
  DEFAULT_RULESET,
  SSE_ROUTES,
  type ImportSource,
  type ImportedSegmentBrief,
  type ProgressView,
  type RedactionReportView,
  type ObjectStorePort,
  type NotifyImportCompletedPayload,
} from '@cb/shared';
import { gunzipSync } from 'node:zlib';
import type { JobContext, JobHandler, JobResult, LeasedJob, Queryable } from '../../platform/jobs/types.js';
import {
  parseSessions,
  computeContentHash,
  detectSessionSource,
  splitBundlePart,
  type RawSessionInput,
  type ParsedSegment,
} from './session-parse.js';
import type { ImportSubjectRef } from './create-job.js';
import { backfillDraftSnapshot } from '../drafts/index.js';
import {
  insertSnapshotProtected,
  insertSegmentProtected,
  supersedePriorSnapshots,
  markRawPurgedProtected,
} from './snapshot-repo.js';
import { emitInTx, eventIdFor } from '../../platform/events/outbox.js';
import { withTransaction, type Tx, type TxPool } from '../../platform/events/db-tx.js';

/** 去掉 NUL(0x00)：Postgres text/jsonb 不接受 0x00（落库 22021）；偶有会话混入二进制/图片垃圾数据带 0x00。
 *   0x00 不是合法文本内容，去掉无损。先 includes 快筛避免对绝大多数干净文本跑正则。 */
function stripNul(s: string): string {
  // eslint-disable-next-line no-control-regex -- 故意匹配 NUL(0x00) 剥离（Postgres text/jsonb 不接受 0x00）
  return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
}

/** 抛出带分类 code 的业务错误（runner.normalizeToErrorBody 据 code 归一人话信封，绝不裸露原始报错）。 */
function codedError(code: (typeof ErrorCode)[keyof typeof ErrorCode], message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/**
 * 收尾事务「fence-out」哨兵（Codex P1-r4）。completeJobInTx 0 行（被取消/接管换 fence/status 失效）时**抛它**触发
 *   withTransaction ROLLBACK——使同事务内刚写的 supersede 一并回滚（绝不污染血缘）。外层据 `instanceof` 识别并优雅吞掉
 *   （当作 fence-out：不发终态、不当业务失败重试），与「真异常」（上抛 runner 走 failed/重试）区分开。
 *   不带 code（不是对外业务错误）；仅作内部控制流标记。
 */
class FinalizeFencedOut extends Error {
  constructor() {
    super('finalize fenced out (complete guard matched 0 rows); rolled back');
    this.name = 'FinalizeFencedOut';
  }
}

/**
 * 收尾事务开头先锁 job 行（Codex P1-r4：SELECT ... FOR UPDATE）。使 supersede 与 complete 在【同一已锁定的
 *   running/fence 命中状态】下执行——锁住后两者看到的 job 行一致，杜绝「supersede 时 running、complete 前被改」的窗口。
 *   返回是否锁到「本 fence 且 running」的行：false = 已被 fence out（取消/接管），调用方直接判 fence-out 回滚。
 */
async function lockRunningJobInTx(tx: Tx, jobId: string, fenceToken: number): Promise<boolean> {
  const res = await tx.query(
    `SELECT id FROM jobs
      WHERE id = $1 AND fence_token = $2 AND status = 'running'
      FOR UPDATE`,
    [jobId, fenceToken],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护落 completed（§11.A 模板 1）——在【调用方事务 tx】内执行（Codex P0-3 同事务 outbox 的一半）。
 *   与 jobs/repo.completeJob 同一条受保护 CTE（fence + status='running' 内联进 WHERE），但写在传入的 tx 上，
 *   故能与 emitInTx outbox 同一 PG 事务原子提交。0 行 = 已被 fence out（取消/接管）→ 返回 false（调用方回滚、不发通知）。
 */
async function completeJobInTx(
  tx: Tx,
  jobId: string,
  fenceToken: number,
  result: unknown,
  finalProgress: ProgressView,
): Promise<boolean> {
  const res = await tx.query(
    `WITH guard AS (
        SELECT id FROM jobs
         WHERE id = $1 AND fence_token = $2 AND status = 'running'
         FOR UPDATE
     )
     UPDATE jobs j
        SET status      = 'completed',
            result      = $3::jsonb,
            progress    = $4::jsonb,
            error       = NULL,
            finished_at = now(),
            updated_at  = now()
       FROM guard
      WHERE j.id = guard.id`,
    [jobId, fenceToken, JSON.stringify(result ?? null), JSON.stringify(finalProgress)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 收尾完整 ProgressView（导入-08/09：100% + 五项子任务全 done + 已生成段 items 不丢，硬规则③）。
 *   items 用 handler 自己收集的 briefs（同事务落终态时一并写入 jobs.progress，避免被 finalProgress 覆盖丢失，Codex P0-3）。
 */
function completedImportProgress(
  segmentCount: number,
  messageCount: number,
  briefs: ImportedSegmentBrief[],
): ProgressView {
  return {
    percent: 100,
    phrase: `已导入全部对话历史 · 共 ${segmentCount} 段会话 · ${messageCount} 条消息`,
    done: segmentCount,
    total: segmentCount,
    unit: '段会话',
    subtasks: SUBTASK_SEQUENCES.import.map((s) => ({ ...s, status: 'done' as const })),
    items: briefs,
    slow: false,
  };
}

/** 导入 handler 的依赖面（注入便于 mock；worker 入口用真实 infra 装配）。 */
export interface ImportHandlerDeps {
  /** worker 写库 / 受保护 fence CTE 用的 PG 句柄（与 runner 同库；handler 自行取数源原文落产物）。 */
  db: Queryable;
  /** 同事务 outbox（建快照完成 + 发通知同一 PG 事务，70 §2.1）。 */
  txPool: TxPool;
  /** S3 原文拉取（agora-raw 桶；处理完即弃，导入-33）。getObjectText 给 utf-8 文本；getObject 给字节（gzip 打包分片用）。 */
  objectStore: Pick<ObjectStorePort, 'getObjectText' | 'getObject'>;
}

/**
 * 从 S3 key 取来源提示（仅当路径明确含 codex/claude 子串时可信；否则 undefined）。
 *   浏览器选 `.codex/sessions/2026/06/01` 子目录（webkitRelativePath 丢了 `.codex` 前缀）、
 *   助手路径 key（`raw/{owner}/{pairId}/part-N`）都不含标记 → 返回 undefined，交内容嗅探定夺。
 */
function sourceHintFromKey(key: string): Exclude<ImportSource, 'mixed'> | undefined {
  if (/codex/i.test(key)) return 'codex';
  if (/claude/i.test(key)) return 'claude';
  return undefined;
}

/** 去敏后的段（content/title 已抹敏，contentHash 按去敏后内容重算——契约去重键，§6.2）。 */
interface RedactedSegment extends Omit<ParsedSegment, 'contentHash' | 'content' | 'title'> {
  contentHash: string;
  content: string;
  title: string;
}

/** ISO → 'YYYY-MM-DD'（快照 time_span_from/to 用 date 列；UTC 取，避免跑测机时区漂移）。 */
function isoToDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 解析 + 去敏 + 快照内去重（redact/segment 子任务核心）。纯计算，不写库。
 *   - parseSessions(B-18)：原文 JSONL → 段（含原始 content/title）。
 *   - 逐段 redact(B-17) content+title → 重算 content_hash（去敏后内容，§6.2 去重键）。
 *   - 按去敏后 hash 再次快照内去重（导入-22：去敏后判重；解析层已按原文去过一轮，这里兜去敏后撞重）。
 *   - 重算统计四格（去重后真实值，导入-14）。
 */
function parseRedactDedup(inputs: RawSessionInput[]): {
  segments: RedactedSegment[];
  report: RedactionReportView;
  stats: {
    segmentCount: number;
    messageCount: number;
    projectCount: number;
    timeFrom: string | null;
    timeTo: string | null;
    sources: Exclude<ImportSource, 'mixed'>[];
  };
} {
  const parsed = parseSessions(inputs);
  // 批量去敏：把所有段的 content+title 拼进一个数组（title 单独一项，便于按序回填）。
  const toRedact: string[] = [];
  for (const s of parsed.segments) {
    toRedact.push(s.content);
    toRedact.push(s.title);
  }
  const { texts, report } = redactBatch(toRedact, { ruleset: DEFAULT_RULESET });

  const seen = new Set<string>();
  const out: RedactedSegment[] = [];
  let messageCount = 0;
  const projects = new Set<string>();
  const sources = new Set<Exclude<ImportSource, 'mixed'>>();
  let minTime: string | null = null;
  let maxTime: string | null = null;

  parsed.segments.forEach((s, i) => {
    const content = texts[i * 2] ?? s.content;
    const redactedTitle = texts[i * 2 + 1] ?? s.title;
    // 标题为空（去敏后偶发）回退原解析标题；标题本身已是去敏后文本，绝不含明文 PII。
    const title = redactedTitle.length > 0 ? redactedTitle : s.title;
    const contentHash = computeContentHash(content); // 去敏后内容重算（§6.2 去重键）
    if (seen.has(contentHash)) return; // 去敏后撞重 → 跳过（统计不算重，导入-22）
    seen.add(contentHash);
    out.push({ ...s, content, title, contentHash });
    messageCount += s.messageCount;
    sources.add(s.source);
    if (s.project) projects.add(s.project);
    if (s.happenedAt) {
      if (minTime === null || s.happenedAt < minTime) minTime = s.happenedAt;
      if (maxTime === null || s.happenedAt > maxTime) maxTime = s.happenedAt;
    }
  });

  return {
    segments: out,
    report,
    stats: {
      segmentCount: out.length,
      messageCount,
      projectCount: projects.size,
      timeFrom: minTime ? isoToDate(minTime) : null,
      timeTo: maxTime ? isoToDate(maxTime) : null,
      sources: [...sources],
    },
  };
}

/** 段级来源 → 快照级来源（命中两家 = mixed；单家则该家）。 */
function snapshotSource(sources: Exclude<ImportSource, 'mixed'>[]): ImportSource {
  if (sources.length >= 2) return 'mixed';
  return sources[0] ?? 'claude';
}

/**
 * 导入 handler 工厂（注入依赖；worker 入口装配真实 infra，单测注入 mock）。
 */
export function createImportHandler(deps: ImportHandlerDeps): JobHandler {
  const { db, txPool, objectStore } = deps;
  return {
    type: 'import',
    async run(job: LeasedJob, ctx: JobContext): Promise<JobResult> {
      const subject = (job.subjectRef ?? {}) as Partial<ImportSubjectRef>;

      // ① 连接凭证：校验 subject_ref 完整（无原文引用 = 上传未落地，IMPORT_NO_CONTENT，不裸转圈）。
      await ctx.reportSubtask('credential', 'running');
      const rawKeys = Array.isArray(subject.rawS3Keys) ? subject.rawS3Keys : [];
      const source: ImportSource = (subject.source as ImportSource) ?? 'mixed';
      if (rawKeys.length === 0) {
        await ctx.reportSubtask('credential', 'failed');
        throw codedError(ErrorCode.IMPORT_NO_CONTENT, 'no raw objects referenced in subject_ref');
      }
      await ctx.reportSubtask('credential', 'done');
      await ctx.reportProgress({ percent: 5, phrase: '已连接，开始拉取原文…' });

      // ② 拉取会话索引：逐个 getObject 拉回原文（量化文案：已拉 X/Y，导入-07/10）。
      //   打包模式（命令行助手路径，subject.bundle==='sentinel'）：每个 key 是含多个整文件的分片，
      //   getObjectText 后用 splitBundlePart 拆回每个文件原文；非打包（直传路径）：每个 key 就是一个文件。
      await ctx.reportSubtask('fetch_index', 'running');
      const bundled = subject.bundle === 'gzip';
      const unit = bundled ? '个分片' : '个文件';
      const batchHint = source === 'claude' || source === 'codex' ? source : undefined;
      const inputs: RawSessionInput[] = [];
      for (let i = 0; i < rawKeys.length; i++) {
        if (ctx.isCancelled()) return { result: null }; // 安全点：取消即停（已落段保留）。
        const key = rawKeys[i]!;
        // 一个 key 产出一个或多个文件原文：打包分片(gzip)解压后按 sentinel 拆回多文件，非打包就是单文件文本。
        let rawFiles: string[];
        try {
          if (bundled) {
            const bytes = await objectStore.getObject('agora-raw', key);
            rawFiles = splitBundlePart(gunzipSync(Buffer.from(bytes)).toString('utf8'));
          } else {
            rawFiles = [await objectStore.getObjectText('agora-raw', key)];
          }
          // 在最早的文本入口剥掉 NUL(0x00)：Postgres text/jsonb 存不了 0x00（落库报 22021
          //   「invalid byte sequence for encoding UTF8: 0x00」→ 整 job 失败 → 网页「服务开小差了」）。
          //   某些会话（含二进制/图片等垃圾数据）会混进 0x00；它不是合法文本内容，去掉无损。
          //   在此处剥，让下游 parse/hash/去敏/落库都拿到干净文本（content_hash 也据干净文本算，与落库一致）。
          rawFiles = rawFiles.map(stripNul);
        } catch {
          // S3 拉取失败 / gz 解压失败：依赖不可用（人话「系统正在恢复」，可重试，绝不裸 ECONNRESET）。
          await ctx.reportSubtask('fetch_index', 'failed');
          throw codedError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'failed to fetch raw object from S3');
        }
        for (const raw of rawFiles) {
          // 来源识别：路径标记优先（可信时），否则退批级非 mixed 来源作提示，最终按内容嗅探定夺。
          //   浏览器选 .codex 子目录 / 助手路径 key 常不含标记 → 必须按内容定，否则 Codex 误判 claude → 零段（BUG）。
          const detected = detectSessionSource(raw, sourceHintFromKey(key) ?? batchHint);
          inputs.push({ source: detected, raw, sessionRef: key });
        }
        await ctx.reportProgress({
          percent: 5 + Math.round((15 * (i + 1)) / rawKeys.length),
          phrase: `正在拉取原文… 已拉取 ${i + 1} / ${rawKeys.length} ${unit}`,
          done: i + 1,
          total: rawKeys.length,
          unit,
        });
      }
      await ctx.reportSubtask('fetch_index', 'done');

      // ③ 解析 + 去敏（redact 子任务，B-17/B-18 在此落地，验收文案「导入消息并抹掉隐私信息」）。
      await ctx.reportSubtask('redact', 'running');
      await ctx.reportProgress({ percent: 25, phrase: '正在导入消息并抹掉隐私信息…' });
      const { segments, report, stats } = parseRedactDedup(inputs);
      await ctx.reportSubtask('redact', 'done');

      // ④ 切分成段落（去重 + 统计已在 ③ 算好；这里点亮 + 空结果拦截，不生成空完成态，导入-20）。
      await ctx.reportSubtask('segment', 'running');
      if (segments.length === 0) {
        await ctx.reportSubtask('segment', 'failed');
        // 空结果（本机无历史 / 全是坏会话）：终态 failed + IMPORT_NO_CONTENT（runner 归一人话信封 + error 帧）。
        throw codedError(ErrorCode.IMPORT_NO_CONTENT, 'parsed zero segments');
      }
      await ctx.reportProgress({
        percent: 50,
        phrase: `切分完成 · 共 ${stats.segmentCount} 段会话 · ${stats.messageCount} 条消息`,
        done: stats.segmentCount,
        total: stats.segmentCount,
        unit: '段会话',
      });
      await ctx.reportSubtask('segment', 'done');

      // ⑤ 生成原始数据：建快照（新快照，旧保留）→ 边写段边 item-appended（已生成不丢）→ 血缘归并 → 同事务发通知。
      await ctx.reportSubtask('snapshot', 'running');
      const snapshotId = await insertSnapshotProtected(db, {
        jobId: job.id,
        fenceToken: job.fenceToken,
        source: snapshotSource(stats.sources),
        sources: stats.sources,
        rawS3Key: rawKeys[0] ?? null,
        segmentCount: stats.segmentCount,
        messageCount: stats.messageCount,
        projectCount: stats.projectCount,
        timeFrom: stats.timeFrom,
        timeTo: stats.timeTo,
        redactionReport: report,
        rulesetVersion: report.rulesetVersion,
      });
      if (!snapshotId) {
        // 建快照被 fence out（取消/接管换 fence）：干净退出（runner 据 isCancelled/fence-out 兜，不报错）。
        return { result: null };
      }

      // 逐段受保护写入 + 边写边 item-appended（导入-09 落库卡逐条浮现，永不裸转圈、已生成不丢）。
      let written = 0;
      const briefs: ImportedSegmentBrief[] = []; // 收尾 finalProgress.items 用（同事务落终态不丢已生成，Codex P0-3）。
      for (let i = 0; i < segments.length; i++) {
        if (ctx.isCancelled()) break; // 取消：停在安全点，已写段保留（导入-35）。
        const s = segments[i]!;
        const res = await insertSegmentProtected(db, {
          snapshotId,
          fenceToken: job.fenceToken,
          contentHash: s.contentHash,
          source: s.source,
          title: s.title,
          dateLabel: s.dateLabel,
          happenedAt: s.happenedAt,
          project: s.project ?? null,
          messageCount: s.messageCount,
          content: s.content,
        });
        if (res.reason === 'fenced_out') break; // 被接管：停，已写段保留。
        if (res.inserted && res.segmentId) {
          written++;
          const brief: ImportedSegmentBrief = {
            segmentId: res.segmentId,
            dateLabel: s.dateLabel,
            title: s.title,
            messageCount: s.messageCount,
            status: 'imported',
          };
          briefs.push(brief);
          await ctx.appendItem(brief); // 受保护持久化 + item-appended 帧（runner 内带 fence）。
        }
        await ctx.reportProgress({
          percent: 50 + Math.round((45 * (i + 1)) / segments.length),
          phrase: `生成原始数据… 已入 ${written} / ${segments.length} 段会话`,
          done: i + 1,
          total: segments.length,
          unit: '段会话',
        });
      }

      // 原文清弃标记（导入-33）：worker 处理完原文即标 raw_purged_at（S3 删对象由 sweeper orphan 驱动）。
      //   本身受 fence 守门（取消/接管 → 0 行不标）；血缘归并 supersede 移入下方收尾同事务（取消不污染血缘，Codex P1-r3）。
      await markRawPurgedProtected(db, snapshotId, job.fenceToken).catch(() => false);

      await ctx.reportSubtask('snapshot', 'done');

      // ⑥ 同事务收尾（Codex P0-3 + P1-r3 + P1-r4）：在【同一 PG 事务】里把「血缘归并(supersede) + 最终业务状态(completed)
      //    + job 结果 + outbox 通知」一并原子提交——绝不另起事务、绝不吞失败。
      //    顺序：先锁 job 行（FOR UPDATE）→ supersede（趁 status 仍 running，经赢家 fence guard）→ completeJob（落 completed）→ emitInTx。
      //      · **先锁 job 行（Codex P1-r4）**：supersede 与 complete 共享【同一已锁定的 running/fence 命中状态】，
      //        锁后 job 行不被并发改，杜绝「supersede 看到 running、complete 前被取消/接管」的窗口。锁不到（已 fence out）→ 直接哨兵回滚。
      //      · supersede 经 job 当前 fence + status='running' guard：取消/fence-out 路径 guard 0 行 → 不动旧快照血缘。
      //      · completeJob 0 行 = 已被 fence out（取消/接管/status 失效）→ **抛 FinalizeFencedOut 哨兵触发 ROLLBACK**
      //        （连刚写的 supersede 一起回滚，绝不污染血缘）；外层捕获哨兵当 fence-out 优雅处理（不发通知、不重试，runner 兜）。
      //        ⚠️ 旧实现这里只 `return false`：withTransaction 对非 throw 返回值会 **COMMIT** → supersede 被提交污染血缘（Codex r4 命中）。
      //      · completeJob >0 行 = 落 completed 成功 → 同事务 emitInTx outbox → 一起 COMMIT（血缘+状态+通知整体成功）。
      //    任一步抛非哨兵错 → withTransaction ROLLBACK → 整体失败、由 runner 走 failed/重试（绝无「血缘改了但状态没落」）。
      const finalProgress = completedImportProgress(stats.segmentCount, stats.messageCount, briefs);
      let finalized = false;
      try {
        await withTransaction(txPool, async (tx) => {
          // 收尾事务开头先锁 job 行（FOR UPDATE）：supersede 与 complete 共享同一已锁定 running/fence 命中状态（Codex P1-r4）。
          //   锁不到（取消/接管换 fence/status≠running）→ 抛哨兵回滚（此时尚未写血缘，回滚等价空操作；哨兵让外层走 fence-out）。
          const locked = await lockRunningJobInTx(tx, job.id, job.fenceToken);
          if (!locked) throw new FinalizeFencedOut();
          // 血缘归并（导入-21）：趁 job 仍 running 且已锁定，经【赢家 fence】把旧 latest 快照 superseded_by ← 新快照。
          //   取消/接管换 fence → guard 0 行 → 不动血缘（取消不污染血缘，Codex P1-r3）；与下方 completeJob 同事务原子。
          await supersedePriorSnapshots(tx, snapshotId, job.ownerUserId, job.id, job.fenceToken);
          const completed = await completeJobInTx(
            tx,
            job.id,
            job.fenceToken,
            { snapshotId },
            finalProgress,
          );
          // fence out（已锁定却 0 行 = status 已变/竞态）→ 抛哨兵触发 ROLLBACK（含上面 supersede 一起回滚），不发通知。
          if (!completed) throw new FinalizeFencedOut();
          // 草稿落点回填（P0-2）：本 import 由某草稿发起（subject.draftId）→ 同事务把 snapshot_id + current_step='extract'
          //   焊到该草稿（owner 守卫 + 单次写 + current_step 永不倒退）。0 行（无 draftId / 草稿已弃 / 非本人）= 无害 no-op：
          //   snapshot 是 import 真源，草稿只是续传指针，回填失败【不回滚 import】（不抛、不挡 completed/通知，已生成不丢）。
          if (typeof subject.draftId === 'string' && subject.draftId.length > 0) {
            await backfillDraftSnapshot(tx, {
              draftId: subject.draftId,
              ownerUserId: job.ownerUserId,
              snapshotId,
            });
          }
          const payload: NotifyImportCompletedPayload = {
            recipientId: job.ownerUserId,
            link: SSE_ROUTES.jobEvents(job.id),
            traceId: ctx.traceId,
            occurredAt: new Date().toISOString(),
            jobId: job.id,
            attemptNo: job.attemptNo,
            snapshotId,
            segmentCount: stats.segmentCount,
          };
          await emitInTx(tx, {
            eventId: eventIdFor.importCompleted(job.id, job.attemptNo),
            topic: 'notify.import_completed',
            aggregateId: job.id,
            payload,
            traceId: ctx.traceId,
          });
        });
        finalized = true; // 事务成功 COMMIT（completed + supersede + outbox 一起落）。
      } catch (err) {
        if (err instanceof FinalizeFencedOut) {
          // fence-out（哨兵）：整事务已 ROLLBACK（supersede 一起回滚，血缘未污染）→ 当作 fence-out 优雅处理，
          //   不发终态、不当业务失败重试（runner 据 fence/isCancelled 兜）。finalized 保持 false 走下方 fence-out 分支。
          finalized = false;
        } else {
          // 同事务整体失败（真异常）：状态未落、通知未发、血缘已回滚（原子）。上抛让 runner 走 failed/重试——
          //   绝不「吞失败」造成不一致（Codex P0-3）。
          throw codedError(
            ErrorCode.INTERNAL,
            `import finalize tx failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 进度收尾帧（done 帧由 runner 据 finalized 发，这里推 100% progress 帧让在线页面即时到顶）。
      await ctx.reportProgress({
        percent: 100,
        phrase: `已导入全部对话历史 · 共 ${stats.segmentCount} 段会话`,
        done: stats.segmentCount,
        total: stats.segmentCount,
        unit: '段会话',
      });

      if (!finalized) {
        // fence out（completeJobInTx 0 行）：不算成功落终态；交还 runner 据 fence 兜（不发 done(completed)）。
        return { result: { snapshotId } };
      }
      // 同事务已落 completed + outbox：告诉 runner 别再 completeJob，仅发 done（result.snapshotId，导入-06/12）。
      return { result: { snapshotId }, finalized: true, finalProgress };
    },
  };
}

export const IMPORT_SUBTASK_KEYS = SUBTASK_SEQUENCES.import.map((s) => s.key);
