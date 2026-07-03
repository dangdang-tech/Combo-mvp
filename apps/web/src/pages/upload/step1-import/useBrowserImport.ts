// 浏览器直传编排 hook（F-10，BUG-013）——选文件/目录/拖拽 → presign → 分批 PUT 原文 → 建 Job。
//
// 链路（B-20 直传主路径，20 §2 时序阶段 A→B）：
//   1. 用户在浏览器选文件/目录/拖拽 → 切成多个 part（按 PART_SIZE 切大文件、小文件各成一片）。
//   2. presignUploads 申请预签名 URL（带请求体只读 POST，可断点续传重签同 uploadId）。
//   3. 分批 PUT 原文到对象存储（并发受限 UPLOAD_CONCURRENCY + 进度累计 bytesSent/bytesTotal）。
//   4. createImportJob 引用 uploadId 建 Job（写命令幂等，复用同 idempotencyKey 防重复建）→ 拿 jobId。
//   5. 把 jobId 交回 ImportStepPage 现有「jobId → SSE → 完成态」链路。
//
// 三原则落地：
//   - 永不裸转圈：phase（idle/preparing/uploading/creating）+ 量化进度（percent/bytesSent/partsDone），上传中态有进度条与退路。
//   - 绝不裸露错误码：失败一律人话 ApiError（userMessage + action）；上层据 action 给重试/换输入。
//   - 已生成内容不丢：已 PUT 完成的 part 不重传（断点续传按 clientPartId 续）；重试只补未完成 part，
//     建 Job 复用同 idempotencyKey（同 uploadId 重放回放同一 jobId，导入-23/31）。
import { useCallback, useRef, useState } from 'react';
import type { ImportSource } from '@cb/shared';
import { ApiError } from '../../../api/index.js';
import {
  presignUploads,
  putUploadPart,
  createImportJob,
  type PresignPartInput,
} from './importApi.js';

/** 单 part 目标字节（大文件按此切片分批直传；小文件各自成一片）。8 MiB 对齐助手脚本 PART_SIZE。 */
export const PART_SIZE_BYTES = 8 * 1024 * 1024;
/** 并发上传的 part 数上限（受限并发，避免一次拉满连接，也便于进度可感知）。 */
export const UPLOAD_CONCURRENCY = 3;

/** 编排阶段（永不裸转圈：每阶段都有量化进度或人话）。 */
export type BrowserImportPhase =
  | 'idle' // 未开始（空态）
  | 'preparing' // 切片 + presign 申请预签名 URL
  | 'uploading' // 分批 PUT 原文（带进度条）
  | 'creating' // 全部传完，建 Job（拿 jobId）
  | 'error'; // 失败（带人话 + 退路）

export interface BrowserImportProgress {
  phase: BrowserImportPhase;
  /** 总字节（用于进度分母）。 */
  bytesTotal: number;
  /** 已传完字节（已 PUT 成功的 part 字节累计）。 */
  bytesSent: number;
  /** 0–100 整数百分比（uploading 期量化文案）。 */
  percent: number;
  /** 总 part 数。 */
  partsTotal: number;
  /** 已传完 part 数。 */
  partsDone: number;
  /** 失败时的人话错误（绝不裸露 code，硬规则②）。 */
  error?: ApiError;
}

export interface UseBrowserImportResult {
  progress: BrowserImportProgress;
  /** 选了文件/目录/拖拽后调用：编排到拿 jobId，成功回调 onJobId（上层转 SSE）。 */
  start: (files: File[]) => void;
  /** 续传/重试（断点续传：已传 part 不重传，只补未完成 part + 重建 Job 复用同 key）。 */
  retry: () => void;
  /** 重置回 idle（取消/重新选）。 */
  reset: () => void;
  /** 是否在途（preparing/uploading/creating；按钮禁用、永不裸转圈）。 */
  busy: boolean;
}

const IDLE: BrowserImportProgress = {
  phase: 'idle',
  bytesTotal: 0,
  bytesSent: 0,
  percent: 0,
  partsTotal: 0,
  partsDone: 0,
};

/** 把选中的文件切成 part 列表（大文件按 PART_SIZE 切片，clientPartId 稳定可断点续传对账）。 */
interface PartPlan {
  clientPartId: string;
  blob: Blob;
  sizeBytes: number;
}
function planParts(files: File[]): PartPlan[] {
  const parts: PartPlan[] = [];
  files.forEach((file, fileIdx) => {
    // webkitRelativePath（目录导入）或 name，做 clientPartId 前缀，稳定可读、断点续传同片同 id。
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const base = `${fileIdx}-${rel}`;
    if (file.size <= PART_SIZE_BYTES) {
      parts.push({ clientPartId: `${base}#0`, blob: file, sizeBytes: file.size });
      return;
    }
    let offset = 0;
    let chunkIdx = 0;
    while (offset < file.size) {
      const end = Math.min(offset + PART_SIZE_BYTES, file.size);
      parts.push({
        clientPartId: `${base}#${chunkIdx}`,
        blob: file.slice(offset, end),
        sizeBytes: end - offset,
      });
      offset = end;
      chunkIdx += 1;
    }
  });
  return parts;
}

/** 兜底人话信封（编排意外失败时，永不裸错）。 */
function fallbackError(userMessage: string): ApiError {
  return new ApiError({ error: { userMessage, retriable: true, action: 'retry', traceId: '' } });
}

/**
 * 浏览器直传编排。onJobId 成功回调把 jobId 交回上层（ImportStepPage 现有 SSE 链路复用）。
 * source 默认 'mixed'（浏览器选文件可能混 claude/codex；仅用于 key 命名/统计，不改去敏逻辑）。
 */
export function useBrowserImport(opts: {
  onJobId: (jobId: string) => void;
  source?: ImportSource;
  draftId?: string | undefined;
}): UseBrowserImportResult {
  const { onJobId } = opts;
  const source: ImportSource = opts.source ?? 'mixed';
  const draftId = opts.draftId;

  const [progress, setProgress] = useState<BrowserImportProgress>(IDLE);

  // 续传 / 重试基线（已选 part 计划 + 已传完 part 集合 + 复用幂等键 + uploadId）。ref 保活跨重试。
  const planRef = useRef<PartPlan[]>([]);
  const doneIdsRef = useRef<Set<string>>(new Set());
  const idempotencyKeyRef = useRef<string>('');
  // presign 回的 uploadId（建 Job 引用）；续传复用同 uploadId，断点续传基线。
  const uploadIdRef = useRef<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  // 防并发触发（一次只跑一条编排）。
  const runningRef = useRef(false);

  const newIdempotencyKey = (): string => {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  };

  // 受限并发跑一批任务（保留报错，便于失败收口）。
  const runLimited = async (
    tasks: Array<() => Promise<void>>,
    limit: number,
    signal: AbortSignal,
  ): Promise<void> => {
    let next = 0;
    let firstError: unknown = null;
    const worker = async (): Promise<void> => {
      while (next < tasks.length && !firstError && !signal.aborted) {
        const idx = next;
        next += 1;
        try {
          await tasks[idx]!();
        } catch (e) {
          if (!firstError) firstError = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    if (firstError) throw firstError;
  };

  // 核心编排：presign 未传完 part → 分批 PUT → 全传完建 Job → onJobId。
  const orchestrate = useCallback(async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const plan = planRef.current;
    const bytesTotal = plan.reduce((s, p) => s + p.sizeBytes, 0);
    // 已传完字节（续传基线：已 done 的 part 字节先计入，进度不回退，已生成内容不丢）。
    const sentDone = plan
      .filter((p) => doneIdsRef.current.has(p.clientPartId))
      .reduce((s, p) => s + p.sizeBytes, 0);
    let bytesSent = sentDone;
    const partsTotal = plan.length;

    const emit = (phase: BrowserImportPhase): void => {
      setProgress({
        phase,
        bytesTotal,
        bytesSent,
        percent: bytesTotal > 0 ? Math.min(100, Math.round((bytesSent / bytesTotal) * 100)) : 0,
        partsTotal,
        partsDone: doneIdsRef.current.size,
      });
    };

    try {
      // 仅 presign 未传完的 part（续传：已 done 的不重签、不重传，导入-31）。
      const pending = plan.filter((p) => !doneIdsRef.current.has(p.clientPartId));
      if (pending.length > 0) {
        emit('preparing');
        const presignParts: PresignPartInput[] = pending.map((p) => ({
          clientPartId: p.clientPartId,
          sizeBytes: p.sizeBytes,
        }));
        const signed = await presignUploads(
          { parts: presignParts, source, totalBytes: bytesTotal },
          { signal: ctrl.signal },
        );
        // 缓存 uploadId（建 Job 引用 + 续传复用同会话；带 import.presign scope 时同 uploadId 回放）。
        uploadIdRef.current = signed.uploadId;
        const urlById = new Map(signed.parts.map((sp) => [sp.clientPartId, sp.url]));

        emit('uploading');
        const tasks = pending.map((p) => async (): Promise<void> => {
          const url = urlById.get(p.clientPartId);
          if (!url) throw fallbackError('上传准备出了点问题，点重试再来一次。');
          await putUploadPart(url, p.blob, { signal: ctrl.signal });
          // 单 part 成功即标 done + 累加进度（断点续传基线 + 进度量化）。
          doneIdsRef.current.add(p.clientPartId);
          bytesSent += p.sizeBytes;
          emit('uploading');
        });
        await runLimited(tasks, UPLOAD_CONCURRENCY, ctrl.signal);
      }

      if (ctrl.signal.aborted) return;

      const uploadId = uploadIdRef.current;
      if (!uploadId) throw fallbackError('上传准备出了点问题，点重试再来一次。');

      // 全部 part 传完 → 建 Job（复用同 idempotencyKey，同 uploadId 重放回放同一 jobId，导入-23）。
      emit('creating');
      const job = await createImportJob(
        {
          uploadId,
          source,
          ...(draftId ? { draftId } : {}),
          idempotencyKey: idempotencyKeyRef.current,
        },
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      runningRef.current = false;
      onJobId(job.id);
    } catch (e) {
      runningRef.current = false;
      if (e instanceof DOMException && e.name === 'AbortError') return; // 取消/卸载：静默。
      const err = e instanceof ApiError ? e : fallbackError('导入没能开始，请稍后重试。');
      setProgress((prev) => ({ ...prev, phase: 'error', error: err }));
    }
  }, [source, draftId, onJobId]);

  const start = useCallback(
    (files: File[]): void => {
      if (runningRef.current) return;
      if (files.length === 0) {
        setProgress({
          ...IDLE,
          phase: 'error',
          error: fallbackError('没选到可导入的文件，换个目录或文件再试。'),
        });
        return;
      }
      planRef.current = planParts(files);
      doneIdsRef.current = new Set();
      idempotencyKeyRef.current = newIdempotencyKey();
      uploadIdRef.current = null;
      void orchestrate();
    },
    [orchestrate],
  );

  const retry = useCallback((): void => {
    if (runningRef.current) return;
    if (planRef.current.length === 0) return;
    // 续传：已 done 的 part 不重传，只补未完成 part；建 Job 复用同 key（已生成内容不丢，导入-31）。
    void orchestrate();
  }, [orchestrate]);

  const reset = useCallback((): void => {
    ctrlRef.current?.abort();
    runningRef.current = false;
    planRef.current = [];
    doneIdsRef.current = new Set();
    uploadIdRef.current = null;
    setProgress(IDLE);
  }, []);

  const busy =
    progress.phase === 'preparing' ||
    progress.phase === 'uploading' ||
    progress.phase === 'creating';

  return { progress, start, retry, reset, busy };
}
