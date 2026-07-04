// 提取流水线（worker 执行体）：拉原文 → 解析 → 脱敏 → 切段 → LLM 归纳 → 逐项落能力项 → 清理原始件 → 终态。
//   - claimTask 领租约防双跑（0 行 = 已被认领，直接跳过；对账循环重投的重复触发在这里被吸收）。
//   - 进度真源是 tasks.meta.progress（SSE state_snapshot 从它读全量）；每步同时把帧推 redis_hot 流。
//   - 失败：last_error 写人话错误体（errorBodyFor 组装）、status=failed、done 帧带 error。
//   - 终态写回都走 service.transition（乐观锁，0 行 = 已被接管，安全退出不发终态帧）。
import { randomUUID } from 'node:crypto';
import {
  CapabilityDefinitionSchema,
  ErrorCode,
  PIPELINE_SUBTASKS,
  errorBodyFor,
  redactBatch,
  type ErrorBody,
  type ErrorCodeValue,
  type LlmGatewayPort,
  type ObjectStorePort,
  type ProgressView,
  type SubtaskStatus,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { TaskEventBridge } from '../../platform/sse/event-stream.js';
import type { LlmAuditSink } from '../../platform/infra/llm/types.js';
import { transition } from './service.js';
import {
  claimTask,
  markUploadProcessed,
  mergeUploadMeta,
  partsState,
  readUploadForPipeline,
  renewLease,
  saveTaskProgress,
} from './repo.js';
import { RAW_BUCKET } from './pairing.js';
import { detectSessionSource, parseSessions, splitBundle } from './session-parse.js';
import { extractCapabilities, type ExtractSegment } from './extract.js';
import { insertCapability } from '../capability/repo.js';

/** 能力项可运行定义所在桶（长期保留，与会被清除的原始件分桶）。 */
export const CAPABILITY_BUCKET = 'agora-artifacts' as const;

/** 能力项定义对象键。 */
export function capabilityDefinitionKey(capabilityId: string): string {
  return `capabilities/${capabilityId}/definition.json`;
}

export interface PipelineDeps {
  db: Queryable;
  objectStore: ObjectStorePort;
  stream: TaskEventBridge;
  llm: LlmGatewayPort;
  audit: LlmAuditSink;
  /** 本 worker 标识（hostname#pid），领租约用。 */
  leaseOwner: string;
  /** 审计记账用的模型名。 */
  model?: string;
  log?: {
    info: (o: object, m: string) => void;
    warn: (o: object, m: string) => void;
    error: (o: object, m: string) => void;
  };
}

export type PipelineOutcome = 'succeeded' | 'failed' | 'not_claimed' | 'superseded';

/** 带内部 code 的流水线失败（人话信封由 code 经 errorBodyFor 组装）。 */
class PipelineFailure extends Error {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineFailure';
  }
}

/** 进度上报器：持久化 tasks.meta.progress（快照真源）+ 推增量帧到 redis 流。 */
class ProgressReporter {
  private readonly view: ProgressView;

  constructor(
    private readonly db: Queryable,
    private readonly stream: TaskEventBridge,
    private readonly taskId: string,
  ) {
    this.view = {
      percent: 0,
      phrase: '正在准备…',
      subtasks: PIPELINE_SUBTASKS.map((s) => ({ key: s.key, label: s.label, status: 'pending' })),
    };
  }

  /** 子任务点亮 + 全量快照帧（子任务变化只在 state_snapshot 里承载，前端据此逐条点亮）。 */
  async subtask(
    key: string,
    status: SubtaskStatus,
    percent: number,
    phrase: string,
  ): Promise<void> {
    for (const s of this.view.subtasks) if (s.key === key) s.status = status;
    this.view.percent = Math.max(this.view.percent, percent); // 单调不倒退
    this.view.phrase = phrase;
    await saveTaskProgress(this.db, this.taskId, this.view);
    await this.stream.publish(this.taskId, {
      event: 'state_snapshot',
      payload: { progress: this.view },
    });
  }

  /** 步内量化进度（增量 progress 帧；持久化同步跟上，断线重连不丢）。 */
  async progress(
    percent: number,
    phrase: string,
    counts?: { done: number; total: number; unit: string },
  ): Promise<void> {
    this.view.percent = Math.max(this.view.percent, percent);
    this.view.phrase = phrase;
    if (counts) {
      this.view.done = counts.done;
      this.view.total = counts.total;
      this.view.unit = counts.unit;
    }
    await saveTaskProgress(this.db, this.taskId, this.view);
    await this.stream.publish(this.taskId, {
      event: 'progress',
      payload: { percent: this.view.percent, phrase, ...(counts ?? {}) },
    });
  }

  snapshot(): ProgressView {
    return this.view;
  }
}

/**
 * 流水线主入口。返回值仅供日志/BullMQ 记录；tasks 表才是状态真源。
 * 'not_claimed'：租约被占（重复触发），静默跳过。'superseded'：跑完落终态时 0 行（已被接管）。
 */
export async function runPipeline(
  deps: PipelineDeps,
  taskId: string,
  traceId: string,
): Promise<PipelineOutcome> {
  const claimed = await claimTask(deps.db, { taskId, leaseOwner: deps.leaseOwner });
  if (!claimed) return 'not_claimed';

  const reporter = new ProgressReporter(deps.db, deps.stream, taskId);
  try {
    const capabilityCount = await execute(deps, taskId, traceId, claimed.ownerUserId, reporter);

    // 终态：extract+succeeded（乐观锁 0 行 = 已被接管，不发终态帧）。
    const done = await transition(
      deps.db,
      taskId,
      { step: 'extract', status: 'running' },
      { status: 'succeeded', lastError: null, retry: 'reset' },
    );
    if (!done) return 'superseded';
    await deps.stream.publish(taskId, {
      event: 'done',
      payload: { status: 'succeeded', result: { capabilityCount } },
    });
    return 'succeeded';
  } catch (err) {
    const code = err instanceof PipelineFailure ? err.code : ErrorCode.INTERNAL;
    deps.log?.error({ err, taskId, traceId, code }, 'pipeline failed');
    const { body } = errorBodyFor(code, traceId);
    const failed = await transition(
      deps.db,
      taskId,
      { step: 'extract', status: 'running' },
      { status: 'failed', lastError: body },
    );
    if (!failed) return 'superseded';
    await publishFailure(deps.stream, taskId, body);
    return 'failed';
  }
}

/** 失败帧序：先 error（完整对外信封）再 done（带同一信封）。 */
async function publishFailure(
  stream: TaskEventBridge,
  taskId: string,
  body: ErrorBody,
): Promise<void> {
  const envelope = { error: body };
  await stream.publish(taskId, { event: 'error', payload: envelope });
  await stream.publish(taskId, { event: 'done', payload: { status: 'failed', error: envelope } });
}

/** 流水线主体（成功路径）。返回产出的能力项数。 */
async function execute(
  deps: PipelineDeps,
  taskId: string,
  traceId: string,
  ownerUserId: string,
  reporter: ProgressReporter,
): Promise<number> {
  // ① fetch：拉收齐的完整原始件。
  await reporter.subtask('fetch', 'running', 2, '正在读取上传内容…');
  const upload = await readUploadForPipeline(deps.db, taskId);
  if (!upload?.storageKey) {
    throw new PipelineFailure(ErrorCode.UPLOAD_NO_CONTENT, 'upload storage_key missing');
  }
  let raw: string;
  try {
    raw = await deps.objectStore.getObjectText(RAW_BUCKET, upload.storageKey);
  } catch (err) {
    throw new PipelineFailure(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      `raw object unreadable: ${String(err)}`,
    );
  }
  if (!raw.trim()) throw new PipelineFailure(ErrorCode.UPLOAD_NO_CONTENT, 'raw object empty');
  await reporter.subtask('fetch', 'done', 10, '上传内容读取完成');

  // ② 解析 + 切段（先切段再脱敏：脱敏作用在段正文上，报告聚合到上传级）。
  const files = splitBundle(raw);
  const inputs = (files.length > 0 ? files : [raw]).map((text, i) => ({
    source: detectSessionSource(text),
    raw: text,
    sessionRef: `file-${i}`,
  }));
  const parsed = parseSessions(inputs);
  if (parsed.segments.length === 0) {
    throw new PipelineFailure(ErrorCode.UPLOAD_NO_CONTENT, 'no parseable segments');
  }

  // ③ redact：合规硬要求，先抹隐私再进任何 LLM/落库路径。
  await reporter.subtask('redact', 'running', 15, '正在抹掉隐私信息…');
  const redacted = redactBatch(parsed.segments.map((s) => s.content));
  await mergeUploadMeta(deps.db, taskId, {
    parseStats: parsed.stats,
    redaction: redacted.report,
  });
  await reporter.subtask(
    'redact',
    'done',
    30,
    `已抹除 ${redacted.report.totalRedactions} 处隐私信息`,
  );

  // ④ segment：段清单成型（一段 = 一会话，正文换成去敏后文本）。
  await reporter.subtask('segment', 'running', 35, '正在切分会话段落…');
  const segments: ExtractSegment[] = parsed.segments.map((s, i) => ({
    title: s.title,
    content: redacted.texts[i]!,
    ...(s.project ? { project: s.project } : {}),
    messageCount: s.messageCount,
  }));
  await reporter.subtask('segment', 'done', 45, `已切出 ${segments.length} 段会话`);
  await renewLease(deps.db, { taskId, leaseOwner: deps.leaseOwner });

  // ⑤ extract：LLM 归纳（降级兜底在 extract.ts 内收口，不裸抛）。
  await reporter.subtask('extract', 'running', 48, '正在归纳提炼能力…');
  const extracted = await extractCapabilities(
    {
      llm: deps.llm,
      audit: deps.audit,
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    {
      taskId,
      ownerUserId,
      traceId,
      segments,
      onBatchDone: async (segmentsDone, segmentsTotal) => {
        const percent = 48 + Math.round((segmentsDone / segmentsTotal) * 30);
        await reporter.progress(percent, `已分析 ${segmentsDone} / ${segmentsTotal} 段会话`, {
          done: segmentsDone,
          total: segmentsTotal,
          unit: '段',
        });
      },
    },
  );
  await reporter.subtask('extract', 'done', 80, `归纳出 ${extracted.items.length} 个能力项`);
  await renewLease(deps.db, { taskId, leaseOwner: deps.leaseOwner });

  // ⑥ persist：逐项校验 → 写 MinIO 定义 → 插 capabilities 行 → item-appended 帧（边生成边显示）。
  await reporter.subtask('persist', 'running', 82, '正在生成能力项…');
  let landed = 0;
  for (const draft of extracted.items) {
    const capabilityId = randomUUID();
    const definition = CapabilityDefinitionSchema.parse({
      version: 1,
      name: draft.name,
      summary: draft.summary,
      kind: draft.kind,
      instructions: draft.instructions,
      meta: draft.meta,
    });
    const storageKey = capabilityDefinitionKey(capabilityId);
    await deps.objectStore.putObject(
      CAPABILITY_BUCKET,
      storageKey,
      new TextEncoder().encode(JSON.stringify(definition)),
      { contentType: 'application/json' },
    );
    const view = await insertCapability(deps.db, {
      id: capabilityId,
      taskId,
      ownerUserId,
      name: definition.name,
      summary: definition.summary,
      kind: definition.kind,
      storageKey,
      meta: { ...draft.meta, ...(extracted.degraded ? { degraded: true } : {}) },
    });
    landed += 1;
    await deps.stream.publish(taskId, { event: 'item-appended', payload: { item: view } });
    await reporter.progress(
      82 + Math.round((landed / extracted.items.length) * 13),
      `已生成 ${landed} / ${extracted.items.length} 个能力项`,
      { done: landed, total: extracted.items.length, unit: '个' },
    );
  }

  // ⑦ 清理原始件与分片（合规：处理完按期清除，raw_purged_at 只在真删成功时打戳）。
  //    清理失败不翻整个任务，只记日志、留空戳等补清。
  let purged = false;
  try {
    const partKeys = partsState(upload.parts).orderedKeys;
    for (const key of [upload.storageKey, ...partKeys]) {
      await deps.objectStore.delete(RAW_BUCKET, key);
    }
    purged = true;
  } catch (err) {
    deps.log?.error({ err, taskId }, 'raw purge failed (task still succeeds)');
  }
  await markUploadProcessed(deps.db, taskId, purged);
  await reporter.subtask('persist', 'done', 100, `完成：${landed} 个能力项`);

  return landed;
}
