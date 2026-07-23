// local Task 的绑定、设备证明、进度上报和最终能力定义提交。
// 原始输入不经过这些接口；服务端只接收 ProgressView 与最终 CapabilityDefinition v1。
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
  type JsonWebKey,
} from 'node:crypto';
import {
  ClaimLocalExecutionBodySchema,
  CreateLocalTaskBodySchema,
  DevicePublicKeySchema,
  ErrorCode,
  PIPELINE_PROGRESS_RANGES,
  PIPELINE_SUBTASKS,
  ProgressViewSchema,
  ReportLocalProgressBodySchema,
  SubmitLocalResultBodySchema,
  type ClaimLocalExecutionResult,
  type CreateLocalTaskResult,
  type Envelope,
  type ProgressView,
  type ReportLocalProgressResult,
  type SubmitLocalResultResult,
} from '@cb/shared';
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteHandlerMethod,
} from 'fastify';
import { asTxPool, withTransaction } from '../../platform/infra/db-tx.js';
import { sendError } from '../../platform/http/_helpers.js';
import { listCapabilityViews, persistCapabilityDefinitions } from '../capability/index.js';
import { hashPairingCode } from './pairing-code.js';
import {
  claimLocalExecution,
  lockLocalExecutionByToken,
  markLocalResultCommitted,
  readLocalExecutionByToken,
  readTaskView,
  saveTaskProgress,
  setLocalResultCommitting,
  updateLocalProgressCursor,
  type LocalExecutionRow,
} from './repo.js';
import { createLocalTask, transition } from './service.js';

const DEVICE_KEY_HEADER = 'x-combo-device-key';
const DEVICE_TIMESTAMP_HEADER = 'x-combo-device-timestamp';
const DEVICE_SIGNATURE_HEADER = 'x-combo-device-signature';
const TASK_TOKEN_TTL_MS = 60 * 60_000;
const DEVICE_PROOF_MAX_SKEW_MS = 5 * 60_000;

export interface LocalExecutionAuthContext {
  taskId: string;
  ownerUserId: string;
  taskTokenHash: string;
  execution: LocalExecutionRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    localExecution?: LocalExecutionAuthContext;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function publicKeyThumbprint(publicKey: Record<string, unknown>): string {
  const parsed = DevicePublicKeySchema.parse(publicKey);
  return sha256Base64Url(JSON.stringify({ crv: parsed.crv, kty: parsed.kty, x: parsed.x }));
}

function proofPayload(method: string, pathname: string, timestamp: string, body: string): string {
  return [method.toUpperCase(), pathname, timestamp, sha256Base64Url(body)].join('\n');
}

function bearerToken(req: FastifyRequest): string | null {
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
  return match?.[1] ?? null;
}

function eventBridge(req: FastifyRequest) {
  return req.server.infra.taskEvents;
}

function localProgressIsValid(progress: ProgressView, previous: unknown): boolean {
  if (progress.percent > PIPELINE_PROGRESS_RANGES.extract.end) return false;
  const expected = PIPELINE_SUBTASKS.map((subtask) => subtask.key);
  const actual = progress.subtasks.map((subtask) => subtask.key);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return false;
  }
  const persist = progress.subtasks.find((subtask) => subtask.key === 'persist');
  if (!persist || persist.status !== 'pending') return false;
  const previousProgress = ProgressViewSchema.safeParse(previous);
  return !previousProgress.success || progress.percent >= previousProgress.data.percent;
}

function defaultPersistenceSubtasks(): ProgressView['subtasks'] {
  return PIPELINE_SUBTASKS.map((subtask, index) => {
    const status = index < PIPELINE_SUBTASKS.length - 1 ? 'done' : 'pending';
    return { key: subtask.key, label: subtask.label, status };
  });
}

function persistenceProgress(
  previous: unknown,
  completed: boolean,
  itemCount: number,
): ProgressView {
  const parsed = ProgressViewSchema.safeParse(previous);
  const baseSubtasks = parsed.success ? parsed.data.subtasks : defaultPersistenceSubtasks();
  return {
    percent: completed
      ? PIPELINE_PROGRESS_RANGES.persist.end
      : PIPELINE_PROGRESS_RANGES.persist.start,
    phrase: completed ? `完成：${itemCount} 个能力项` : '正在生成能力项…',
    ...(completed ? { done: itemCount, total: itemCount, unit: '个' } : {}),
    subtasks: baseSubtasks.map((subtask) => {
      let status: ProgressView['subtasks'][number]['status'] = subtask.status;
      if (completed) status = 'done';
      else if (subtask.key === 'persist') status = 'running';
      return { ...subtask, status };
    }),
  };
}

async function readCommittedCapabilities(
  req: FastifyRequest,
  auth: LocalExecutionAuthContext,
): Promise<SubmitLocalResultResult> {
  const page = await listCapabilityViews(req.server.infra.db, {
    ownerUserId: auth.ownerUserId,
    taskId: auth.taskId,
    limit: 20,
  });
  const allowed = new Set(auth.execution.resultCapabilityIds ?? []);
  return {
    taskId: auth.taskId,
    currentStep: 'extract',
    status: 'succeeded',
    items: page.items.filter((item) => allowed.has(item.id)),
  };
}

/** 建 local Task：复用 tasks，跳过 uploads 与 Cloud Worker 队列。 */
export function createLocalTaskHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateLocalTaskBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    let outcome;
    try {
      outcome = await createLocalTask(asTxPool(req.server.infra.db), req.server.infra.db, {
        ownerUserId: userId,
        idempotencyKey: parsed.data.idempotencyKey,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create local task failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (outcome.kind === 'conflict') {
      return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
    }
    const task = await readTaskView(req.server.infra.db, outcome.taskId, userId);
    if (!task) return sendError(req, reply, ErrorCode.INTERNAL);
    const result: CreateLocalTaskResult = {
      task,
      localExecution: { bindCode: outcome.bindCode, expiresAt: outcome.bindExpiresAt },
    };
    const body: Envelope<CreateLocalTaskResult> = { data: result, meta: { traceId: req.id } };
    reply
      .header('cache-control', 'no-store')
      .code(outcome.replayed ? 200 : 201)
      .send(body);
    return reply;
  };
}

/** bind code 首次绑定设备；绑定窗口内同一设备可换新 Task Token 以恢复崩溃任务。 */
export function claimLocalExecutionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const { taskId } = req.params as { taskId: string };
    const parsed = ClaimLocalExecutionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    let thumbprint: string;
    try {
      createPublicKey({ key: parsed.data.devicePublicKey as JsonWebKey, format: 'jwk' });
      thumbprint = publicKeyThumbprint(parsed.data.devicePublicKey);
    } catch {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }

    const taskToken = randomBytes(32).toString('base64url');
    const tokenExpiresAt = new Date(Date.now() + TASK_TOKEN_TTL_MS).toISOString();
    const claimed = await claimLocalExecution(req.server.infra.db, {
      taskId,
      bindCodeHash: hashPairingCode(parsed.data.bindCode),
      devicePublicKey: parsed.data.devicePublicKey,
      deviceKeyThumbprint: thumbprint,
      taskTokenHash: sha256Hex(taskToken),
      tokenExpiresAt,
      workerVersion: parsed.data.workerVersion,
      algorithmVersion: parsed.data.algorithmVersion,
    });
    if (!claimed) {
      return sendError(req, reply, ErrorCode.PAIRING_CODE_INVALID, {
        userMessage: '本地任务绑定码无效、已过期或已经使用。',
      });
    }
    const result: ClaimLocalExecutionResult = {
      taskToken,
      tokenExpiresAt,
      nextExpectedSeq: claimed.nextExpectedSeq,
    };
    const body: Envelope<ClaimLocalExecutionResult> = { data: result, meta: { traceId: req.id } };
    reply.header('cache-control', 'no-store').code(200).send(body);
    return reply;
  };
}

/** Task Token + Ed25519 请求签名守卫；通过后把 local execution 上下文注入请求。 */
export function requireLocalExecutionAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const token = bearerToken(req);
    const timestamp = req.headers[DEVICE_TIMESTAMP_HEADER];
    const thumbprint = req.headers[DEVICE_KEY_HEADER];
    const signature = req.headers[DEVICE_SIGNATURE_HEADER];
    if (
      !token ||
      typeof timestamp !== 'string' ||
      typeof thumbprint !== 'string' ||
      typeof signature !== 'string'
    ) {
      return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    }

    const execution = await readLocalExecutionByToken(req.server.infra.db, {
      taskId,
      taskTokenHash: sha256Hex(token),
    });
    if (!execution || !execution.devicePublicKey || execution.deviceKeyThumbprint !== thumbprint) {
      return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    }
    const timestampMs = Date.parse(timestamp);
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > DEVICE_PROOF_MAX_SKEW_MS
    ) {
      return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    }

    const body = JSON.stringify(req.body ?? {});
    let verified = false;
    try {
      verified = verifySignature(
        null,
        Buffer.from(proofPayload(req.method, req.url, timestamp, body)),
        createPublicKey({ key: execution.devicePublicKey as JsonWebKey, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      verified = false;
    }
    if (!verified) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    if (
      execution.executionMode !== 'local' ||
      execution.taskStep !== 'extract' ||
      !['running', 'succeeded'].includes(execution.taskStatus)
    ) {
      return sendError(req, reply, ErrorCode.STATE_CONFLICT);
    }

    req.localExecution = {
      taskId,
      ownerUserId: execution.ownerUserId,
      taskTokenHash: sha256Hex(token),
      execution,
    };
  };
}

export function reportLocalProgressHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const auth = req.localExecution;
    if (!auth) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = ReportLocalProgressBodySchema.safeParse(req.body ?? {});
    if (
      !parsed.success ||
      !localProgressIsValid(parsed.data.progress, auth.execution.taskProgress)
    ) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED, {
        userMessage: '本地进度必须沿用 fetch 到 extract 阶段，persist 由服务端记录。',
      });
    }
    const progressSha256 = sha256Hex(JSON.stringify(parsed.data));

    const outcome = await withTransaction(asTxPool(req.server.infra.db), async (tx) => {
      const locked = await lockLocalExecutionByToken(tx, {
        taskId: auth.taskId,
        taskTokenHash: auth.taskTokenHash,
      });
      if (!locked || locked.taskStatus !== 'running') return { kind: 'unauthenticated' } as const;
      if (parsed.data.seq === locked.lastProgressSeq) {
        return locked.lastProgressSha256 === progressSha256
          ? ({ kind: 'replayed' } as const)
          : ({ kind: 'conflict', nextExpectedSeq: locked.lastProgressSeq + 1 } as const);
      }
      if (
        parsed.data.seq !== locked.lastProgressSeq + 1 ||
        !localProgressIsValid(parsed.data.progress, locked.taskProgress)
      ) {
        return { kind: 'conflict', nextExpectedSeq: locked.lastProgressSeq + 1 } as const;
      }
      await updateLocalProgressCursor(tx, {
        taskId: auth.taskId,
        seq: parsed.data.seq,
        sha256: progressSha256,
      });
      await saveTaskProgress(tx, auth.taskId, parsed.data.progress);
      return { kind: 'accepted' } as const;
    });

    if (outcome.kind === 'unauthenticated') {
      return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    }
    if (outcome.kind === 'conflict') {
      return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
        details: { nextExpectedSeq: outcome.nextExpectedSeq },
      });
    }
    if (outcome.kind === 'accepted') {
      await eventBridge(req).publish(auth.taskId, {
        event: 'state_snapshot',
        payload: { progress: parsed.data.progress },
      });
    }
    const result: ReportLocalProgressResult = {
      acceptedSeq: parsed.data.seq,
      nextExpectedSeq: parsed.data.seq + 1,
    };
    const body: Envelope<ReportLocalProgressResult> = { data: result, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

export function submitLocalResultHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const auth = req.localExecution;
    if (!auth) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = SubmitLocalResultBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const resultSha256 = sha256Hex(JSON.stringify(parsed.data));

    const reservation = await withTransaction(asTxPool(req.server.infra.db), async (tx) => {
      const locked = await lockLocalExecutionByToken(tx, {
        taskId: auth.taskId,
        taskTokenHash: auth.taskTokenHash,
      });
      if (!locked) return { kind: 'unauthenticated' } as const;
      if (locked.resultStatus !== 'pending') {
        if (locked.resultSha256 !== resultSha256 || !locked.resultCapabilityIds) {
          return { kind: 'conflict' } as const;
        }
        return {
          kind:
            locked.resultStatus === 'committed' ? ('committed' as const) : ('reserved' as const),
          ids: locked.resultCapabilityIds,
          execution: locked,
        };
      }
      if (locked.taskStatus !== 'running') return { kind: 'conflict' } as const;
      const ids = parsed.data.items.map(() => randomUUID());
      await setLocalResultCommitting(tx, {
        taskId: auth.taskId,
        resultSha256,
        capabilityIds: ids,
        workerVersion: parsed.data.workerVersion,
        algorithmVersion: parsed.data.algorithmVersion,
      });
      return { kind: 'reserved' as const, ids, execution: locked };
    });

    if (reservation.kind === 'unauthenticated') {
      return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    }
    if (reservation.kind === 'conflict') {
      return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT, {
        userMessage: '这次最终结果和该任务已经提交的结果不一致。',
      });
    }
    if (reservation.kind === 'committed') {
      const result = await readCommittedCapabilities(req, {
        ...auth,
        execution: { ...reservation.execution, resultCapabilityIds: reservation.ids },
      });
      const body: Envelope<SubmitLocalResultResult> = { data: result, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    }

    const persistRunning = persistenceProgress(reservation.execution.taskProgress, false, 0);
    await saveTaskProgress(req.server.infra.db, auth.taskId, persistRunning);
    await eventBridge(req).publish(auth.taskId, {
      event: 'state_snapshot',
      payload: { progress: persistRunning },
    });

    let items;
    const finalProgress = persistenceProgress(persistRunning, true, parsed.data.items.length);
    try {
      const persistItems = parsed.data.items.map((definition, index) => {
        const id = reservation.ids[index];
        if (!id) throw new Error('local result capability reservation is incomplete');
        return {
          id,
          definition,
          indexMeta: {
            ...definition.meta,
            executionMode: 'local',
            workerVersion: parsed.data.workerVersion,
            algorithmVersion: parsed.data.algorithmVersion,
          },
        };
      });
      items = await withTransaction(asTxPool(req.server.infra.db), async (tx) => {
        const views = await persistCapabilityDefinitions(
          { db: tx, objectStore: req.server.infra.objectStore },
          {
            taskId: auth.taskId,
            ownerUserId: auth.ownerUserId,
            items: persistItems,
          },
        );
        await saveTaskProgress(tx, auth.taskId, finalProgress);
        const transitioned = await transition(
          tx,
          auth.taskId,
          { step: 'extract', status: 'running' },
          { status: 'succeeded', lastError: null, retry: 'reset' },
        );
        const committed = await markLocalResultCommitted(tx, { taskId: auth.taskId, resultSha256 });
        if (!transitioned || !committed)
          throw new Error('local result state changed during commit');
        return views;
      });
    } catch (err) {
      req.log.error({ err, taskId: auth.taskId, traceId: req.id }, 'persist local result failed');
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }

    for (const item of items) {
      await eventBridge(req).publish(auth.taskId, {
        event: 'item-appended',
        payload: { item },
      });
    }
    await eventBridge(req).publish(auth.taskId, {
      event: 'state_snapshot',
      payload: { progress: finalProgress },
    });
    await eventBridge(req).publish(auth.taskId, {
      event: 'done',
      payload: { status: 'succeeded', result: { capabilityCount: items.length } },
    });

    const result: SubmitLocalResultResult = {
      taskId: auth.taskId,
      currentStep: 'extract',
      status: 'succeeded',
      items,
    };
    const body: Envelope<SubmitLocalResultResult> = { data: result, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}
