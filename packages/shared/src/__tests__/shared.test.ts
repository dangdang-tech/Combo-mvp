import { describe, it, expect } from 'vitest';
import {
  buildError,
  buildErrorWithCode,
  ErrorBodySchema,
  ErrorCode,
  ErrorEnvelopeSchema,
  sanitizeErrorBody,
  sanitizeErrorEnvelope,
  CLIENT_FALLBACK_TRACE_ID,
  lintUserMessage,
  httpStatusFor,
  REQUIRED_IDEMPOTENCY_SCOPES,
  SSE_EVENT_TYPES,
  ErrorFramePayloadSchema,
  DonePayloadSchema,
  envelopeSchema,
  MeViewSchema,
  CandidateItemSchema,
  CandidateViewSchema,
  CreateCapabilityBodySchema,
  SelectionDraftSchema,
  selectionCandidateIds,
  isSubsetSelection,
  FieldStateSchema,
  FieldFailureErrorBodySchema,
  buildOpenApiDocument,
  REGISTERED_SCHEMA_NAMES,
  OutboxTopicSchema,
  ACTIVE_OUTBOX_TOPICS,
  TOPIC_CLASS,
  ConsumerCursorSchema,
  ConsumerCursorTopicSchema,
  MERGED_LIFECYCLE_CURSOR_TOPIC,
  NotifyReviewDecidedPayloadSchema,
  CapabilityPublishedPayloadSchema,
  CapabilityUnpublishedPayloadSchema,
  NotifyImportCompletedPayloadSchema,
  NotifyExtractCompletedPayloadSchema,
  NotifyPublishCompletedPayloadSchema,
  UsageMeteringPayloadSchema,
  RuntimeSessionEventPayloadSchema,
  buildTraceparent,
  parseTraceparent,
  traceHexToUuid,
  traceIdFromHeaders,
  traceIdFromUrl,
  uuidToTraceHex,
} from '../index.js';
import { z } from 'zod';

describe('Trace helpers', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const hex = '123e4567e89b12d3a456426614174000';

  it('maps public UUID traceId to W3C trace hex and back', () => {
    expect(uuidToTraceHex(uuid)).toBe(hex);
    expect(traceHexToUuid(hex)).toBe(uuid);
  });

  it('parses traceparent before x-trace-id and supports EventSource query fallback', () => {
    const traceparent = buildTraceparent(uuid, '123e4567e89b12d3');
    expect(parseTraceparent(traceparent)?.traceId).toBe(uuid);
    expect(
      traceIdFromHeaders({
        traceparent,
        'x-trace-id': 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      }),
    ).toBe(uuid);
    expect(traceIdFromUrl(`/api/v1/runtime/runs/r1/events?traceId=${uuid}`)).toBe(uuid);
  });
});

describe('ErrorEnvelope', () => {
  it('builds from classification table with userMessage + action', () => {
    const env = buildError(ErrorCode.UNAUTHENTICATED, '01J-trace');
    expect(env.error.action).toBe('escalate');
    expect(env.error.userMessage).toContain('登录');
    expect(ErrorEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('outbound envelope NEVER contains code (D1: code is internal-only)', () => {
    const env = buildError(ErrorCode.EXTRACT_UPSTREAM_TIMEOUT, 't');
    // 对外信封不含 code（仅 userMessage/action/retriable/traceId/failureId?/details?）。
    expect('code' in env.error).toBe(false);
    expect((env.error as Record<string, unknown>).code).toBeUndefined();
    // 即便构造时塞 code 字段，对外 schema 也会剥离（strip）—— 解析结果里无 code。
    const parsed = ErrorBodySchema.parse({
      code: 'SHOULD_BE_STRIPPED',
      userMessage: '人话',
      action: 'retry',
      retriable: true,
      traceId: 't',
    } as Record<string, unknown>);
    expect('code' in parsed).toBe(false);
  });

  it('buildErrorWithCode keeps code internal, envelope code-free (D1)', () => {
    const { code, envelope } = buildErrorWithCode(ErrorCode.INTERNAL, 'tr');
    // 内部 code 单独可读（供日志/告警，经 traceId 关联）。
    expect(code).toBe(ErrorCode.INTERNAL);
    // 对外信封仍不含 code。
    expect('code' in envelope.error).toBe(false);
    expect(envelope.error.traceId).toBe('tr');
  });

  it('SSE error frame payload = full outbound ErrorEnvelope (Codex#2), code-free', () => {
    const env = buildError(ErrorCode.STRUCTURE_FIELD_FAILED, 't', {
      details: { field: 'tagline', attempts: 2 },
    });
    // error 帧 = 完整对外信封（{ error: {...} }），不是裸 ErrorBody。
    expect(ErrorFramePayloadSchema.safeParse(env).success).toBe(true);
    // 裸 ErrorBody（无外层 error 包裹）不被 error 帧 schema 接受。
    expect(ErrorFramePayloadSchema.safeParse(env.error).success).toBe(false);
    // error 帧里不含 code。
    const ok = ErrorFramePayloadSchema.parse(env);
    expect('code' in ok.error).toBe(false);
  });

  it('SSE done frame error = full outbound ErrorEnvelope (Codex#2)', () => {
    const env = buildError(ErrorCode.JOB_TIMEOUT, 't');
    expect(DonePayloadSchema.safeParse({ status: 'failed', error: env }).success).toBe(true);
    // done.error 不接受裸 ErrorBody（须是完整信封）。
    expect(DonePayloadSchema.safeParse({ status: 'failed', error: env.error }).success).toBe(false);
  });

  it('maps code → http status', () => {
    expect(httpStatusFor(ErrorCode.NOT_FOUND)).toBe(404);
    expect(httpStatusFor(ErrorCode.PUBLISH_MISSING_FIELDS)).toBe(422);
  });

  it('all default userMessages are human-readable (no leaked codes/stack/SQL)', () => {
    for (const code of Object.values(ErrorCode)) {
      const env = buildError(code, 't');
      expect(lintUserMessage(env.error.userMessage)).toHaveLength(0);
    }
  });
});

describe('Extract candidate trial capability contract', () => {
  const baseCandidate = {
    id: '11111111-1111-4111-8111-111111111111',
    extractJobId: '22222222-2222-4222-8222-222222222222',
    snapshotId: '33333333-3333-4333-8333-333333333333',
    status: 'ready',
    name: '脚本生成器',
    intent: '生成脚本',
    slug: 'script-maker',
    type: 'recurring',
    confidence: 'high',
    segmentCount: 3,
    frequencyRatio: 0.5,
    reusability: 0.8,
    scopeCoherence: 0.7,
    splitSuggested: false,
    scope: null,
    error: null,
    retryCount: 0,
    createdAt: '2026-06-10T00:00:00.000Z',
  };

  it('accepts prepared trial metadata and remains backward compatible when omitted', () => {
    expect(CandidateViewSchema.parse(baseCandidate).trialCapability).toBeUndefined();
    const prepared = CandidateViewSchema.parse({
      ...baseCandidate,
      trialCapability: {
        capabilityId: '44444444-4444-4444-8444-444444444444',
        versionId: '55555555-5555-4555-8555-555555555555',
        slug: 'script-maker',
      },
    });
    expect(prepared.trialCapability?.versionId).toBe('55555555-5555-4555-8555-555555555555');
    expect(
      CandidateItemSchema.parse({
        id: baseCandidate.id,
        status: 'ready',
        name: baseCandidate.name,
        trialCapability: prepared.trialCapability,
      }).trialCapability?.capabilityId,
    ).toBe('44444444-4444-4444-8444-444444444444');
  });
});

describe('sanitizeErrorBody / sanitizeErrorEnvelope (Codex r2 P1 #2: 白名单重建，无 code/stack 泄漏)', () => {
  it('白名单重建：只保留 userMessage/action/retriable/traceId/failureId?/details?，丢 code/status/stack/原始 message', () => {
    const body = sanitizeErrorBody({
      userMessage: '服务开小差了，请重试。',
      retriable: true,
      action: 'retry',
      traceId: 'tr-1',
      failureId: 'fail-9',
      code: 'INTERNAL',
      status: 500,
      stack: 'Error: boom\n    at f (/srv/a.ts:1:1)',
      message: 'raw upstream error',
    });
    expect(body).toEqual({
      userMessage: '服务开小差了，请重试。',
      retriable: true,
      action: 'retry',
      traceId: 'tr-1',
      failureId: 'fail-9',
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain('INTERNAL');
    expect(json).not.toMatch(/\bstack\b/);
    expect(json).not.toContain('raw upstream error');
  });

  it('details 白名单：仅放行 field/attempts，丢 code/stack/sql；字符串值命中禁止模式也丢', () => {
    const body = sanitizeErrorBody({
      userMessage: '字段没生成出来。',
      retriable: true,
      action: 'retry',
      traceId: 't',
      details: {
        field: 'name',
        attempts: 2,
        code: 'STRUCTURE_FIELD_FAILED',
        stack: 'at g (x:1:1)',
        sql: 'SELECT * FROM users WHERE id=1',
        internalPath: '/srv/secret',
      },
    });
    expect(body.details).toEqual({ field: 'name', attempts: 2 });
  });

  it('details 安全键但值含堆栈串 → 丢该键（防混入）', () => {
    const body = sanitizeErrorBody({
      userMessage: 'x 出错',
      retriable: true,
      action: 'retry',
      traceId: 't',
      details: { field: 'Error: at boom (a.ts:1:1)', attempts: 1 },
    });
    expect(body.details).toEqual({ attempts: 1 }); // field 值命中禁止模式被丢。
  });

  it('非法 action / 缺字段 → 安全缺省（action=retry、retriable=true、traceId 哨兵）', () => {
    const body = sanitizeErrorBody({ userMessage: '只有人话' });
    expect(body.action).toBe('retry');
    expect(body.retriable).toBe(true);
    expect(body.traceId).toBe(CLIENT_FALLBACK_TRACE_ID);
  });

  it('缺 userMessage / 非对象 → 兜底人话', () => {
    expect(sanitizeErrorBody({ action: 'retry' }).userMessage).toBe('出了点小问题，请重试。');
    expect(sanitizeErrorBody(null).userMessage).toBe('出了点小问题，请重试。');
    expect(sanitizeErrorBody('boom').userMessage).toBe('出了点小问题，请重试。');
  });

  it('sanitizeErrorEnvelope：完整信封取内层重建 / 裸 ErrorBody 直取 / 都不像兜底；结果恒过 schema', () => {
    const fromEnvelope = sanitizeErrorEnvelope({
      error: { userMessage: 'a', retriable: false, action: 'escalate', traceId: 't', code: 'X' },
    });
    expect(fromEnvelope.error.userMessage).toBe('a');
    expect((fromEnvelope.error as Record<string, unknown>)['code']).toBeUndefined();
    expect(ErrorEnvelopeSchema.safeParse(fromEnvelope).success).toBe(true);

    const fromBare = sanitizeErrorEnvelope({
      userMessage: 'b',
      retriable: true,
      action: 'retry',
      traceId: 't',
    });
    expect(fromBare.error.userMessage).toBe('b');

    const fallback = sanitizeErrorEnvelope({ garbage: true });
    expect(fallback.error.userMessage).toBe('出了点小问题，请重试。');
    expect(ErrorEnvelopeSchema.safeParse(fallback).success).toBe(true);
  });
});

describe('constants', () => {
  it('exposes 20 required idempotency scopes（含草稿 bootstrap draft.create；批量发布 3 个 scope 已随功能移除）', () => {
    expect(REQUIRED_IDEMPOTENCY_SCOPES.length).toBe(20);
    expect(new Set(REQUIRED_IDEMPOTENCY_SCOPES).size).toBe(20);
  });

  it('exposes exactly 12 SSE event types', () => {
    expect(SSE_EVENT_TYPES.length).toBe(12);
  });
});

describe('zod DTOs', () => {
  it('envelope factory wraps data', () => {
    const schema = envelopeSchema(z.object({ ok: z.boolean() }));
    expect(schema.safeParse({ data: { ok: true } }).success).toBe(true);
  });

  it('MeView parses a valid /me payload', () => {
    const ok = MeViewSchema.safeParse({
      id: 'u1',
      logtoUserId: 'sub1',
      account: 'WAYNE',
      email: null,
      roles: ['creator'],
      status: 'active',
      hasProfile: false,
      creatorId: 'u1',
      createdAt: '2026-06-15T00:00:00Z',
      lastLoginAt: null,
    });
    expect(ok.success).toBe(true);
  });

  it('CreateCapabilityBody enforces EXACTLY-one of three sources (Codex#7)', () => {
    // 恰好一个 → 通过（三分支各一例）。
    expect(CreateCapabilityBodySchema.safeParse({ sourceCandidateId: 'c1' }).success).toBe(true);
    expect(CreateCapabilityBodySchema.safeParse({ capabilityId: 'cap1' }).success).toBe(true);
    expect(CreateCapabilityBodySchema.safeParse({ fromVersionId: 'v1' }).success).toBe(true);
    // 带可选 draftId 不影响「恰好一个 source」判定。
    expect(
      CreateCapabilityBodySchema.safeParse({ sourceCandidateId: 'c1', draftId: 'd1' }).success,
    ).toBe(true);
    // 零个 → 拒。
    expect(CreateCapabilityBodySchema.safeParse({}).success).toBe(false);
    expect(CreateCapabilityBodySchema.safeParse({ draftId: 'd1' }).success).toBe(false);
    // 两个并存（任意配对）→ 拒（含旧 refine 漏掉的 sourceCandidateId+capabilityId）。
    expect(
      CreateCapabilityBodySchema.safeParse({ sourceCandidateId: 'c1', capabilityId: 'cap1' })
        .success,
    ).toBe(false);
    expect(
      CreateCapabilityBodySchema.safeParse({ fromVersionId: 'v1', capabilityId: 'cap1' }).success,
    ).toBe(false);
    expect(
      CreateCapabilityBodySchema.safeParse({ fromVersionId: 'v1', sourceCandidateId: 'c1' })
        .success,
    ).toBe(false);
    // 三个全给 → 拒。
    expect(
      CreateCapabilityBodySchema.safeParse({
        sourceCandidateId: 'c1',
        capabilityId: 'cap1',
        fromVersionId: 'v1',
      }).success,
    ).toBe(false);
  });

  it('SelectionDraft: single / subset / 兼容别名 all（子集化 P0-1，§5.2/§5.3）', () => {
    // single 一个 → 通过。
    expect(SelectionDraftSchema.safeParse({ mode: 'single', candidateId: 'c1' }).success).toBe(
      true,
    );
    // subset 至少一个 → 通过（N==2，可 < total，子集合法，§5.2 批量勾选 N 项）。
    expect(
      SelectionDraftSchema.safeParse({ mode: 'subset', candidateIds: ['c1', 'c2'] }).success,
    ).toBe(true);
    // subset 单项也合法（N=1，子集非空即可）。
    expect(SelectionDraftSchema.safeParse({ mode: 'subset', candidateIds: ['c1'] }).success).toBe(
      true,
    );
    // subset 空数组 → 拒（.min(1)，空选不是合法子集，Codex P1-3）。
    expect(SelectionDraftSchema.safeParse({ mode: 'subset', candidateIds: [] }).success).toBe(
      false,
    );
    // 'all' 向后兼容别名仍通过（旧草稿/未迁移前端续命，= subset 语义）。
    expect(
      SelectionDraftSchema.safeParse({ mode: 'all', candidateIds: ['c1', 'c2'] }).success,
    ).toBe(true);
    expect(SelectionDraftSchema.safeParse({ mode: 'all', candidateIds: [] }).success).toBe(false);
  });

  it('selectionCandidateIds / isSubsetSelection 规范化（single→[一个]，subset/all→数组）', () => {
    expect(selectionCandidateIds({ mode: 'single', candidateId: 'c1' })).toEqual(['c1']);
    expect(selectionCandidateIds({ mode: 'subset', candidateIds: ['c1', 'c2'] })).toEqual([
      'c1',
      'c2',
    ]);
    expect(selectionCandidateIds({ mode: 'all', candidateIds: ['c1'] })).toEqual(['c1']);
    expect(isSubsetSelection({ mode: 'single', candidateId: 'c1' })).toBe(false);
    expect(isSubsetSelection({ mode: 'subset', candidateIds: ['c1'] })).toBe(true);
    expect(isSubsetSelection({ mode: 'all', candidateIds: ['c1'] })).toBe(true);
  });

  it('FieldState: 含 error 字段（无 code 的对外 ErrorBody，Codex P1-7）', () => {
    // failed 态带 error（断线重连 snapshot 回显错误态 + 退路）。
    const ok = FieldStateSchema.safeParse({
      field: 'instructions',
      status: 'failed',
      attempts: 2,
      error: {
        userMessage: '这个字段没生成出来，可重试、改输入或转人工。',
        retriable: true,
        action: 'escalate',
        traceId: '01J000000000000000000000T',
        details: { field: 'instructions', attempts: 2 },
      },
    });
    expect(ok.success).toBe(true);
    // error 内层不含 code（对外 D1）：带 code 也能 parse（ErrorBody strip 未知键）但解析结果无 code。
    if (ok.success) expect('code' in (ok.data.error ?? {})).toBe(false);
    // error 可选：done 态无 error 仍合法。
    expect(FieldStateSchema.safeParse({ field: 'name', status: 'done', value: 'x' }).success).toBe(
      true,
    );
  });

  it('FieldFailureErrorBody（Codex r2 P1）：details.field 须 ∈ SoftFieldKey；硬字段/未知字段 → schema 拒绝', () => {
    const base = {
      userMessage: '这个字段没生成出来，可重试、改输入或转人工。',
      retriable: true,
      action: 'escalate' as const,
      traceId: '01J000000000000000000000T',
    };
    // 软字段 → 接受。
    for (const field of ['name', 'instructions', 'skill_set', 'starter_prompts']) {
      expect(
        FieldFailureErrorBodySchema.safeParse({ ...base, details: { field, attempts: 2 } }).success,
      ).toBe(true);
    }
    // 硬字段（output/id/version/status/inputs/boundaries）→ 拒绝（硬字段锁定不报字段级失败，§2.2/§3.4）。
    for (const field of ['output', 'id', 'version', 'status', 'inputs', 'boundaries']) {
      expect(
        FieldFailureErrorBodySchema.safeParse({ ...base, details: { field, attempts: 2 } }).success,
      ).toBe(false);
    }
    // 未知字段 → 拒绝。
    expect(
      FieldFailureErrorBodySchema.safeParse({ ...base, details: { field: 'bogus', attempts: 1 } })
        .success,
    ).toBe(false);
    // 无 details.field 键 → 不强制（仍合法：error 体不强制带 field）。
    expect(
      FieldFailureErrorBodySchema.safeParse({ ...base, details: { attempts: 1 } }).success,
    ).toBe(true);
    expect(FieldFailureErrorBodySchema.safeParse(base).success).toBe(true);
  });

  it('FieldState.error 接入专用 schema：硬字段 details.field（如 output）→ FieldStateSchema 拒绝（Codex r2 P1）', () => {
    const hardFieldError = {
      field: 'instructions',
      status: 'failed' as const,
      attempts: 2,
      error: {
        userMessage: '这个字段没生成出来，可重试、改输入或转人工。',
        retriable: true,
        action: 'escalate' as const,
        traceId: '01J000000000000000000000T',
        details: { field: 'output', attempts: 2 }, // 硬字段 → 应被专用 schema 拒绝。
      },
    };
    expect(FieldStateSchema.safeParse(hardFieldError).success).toBe(false);
    // 未知字段同样拒绝。
    const unknownFieldError = {
      ...hardFieldError,
      error: { ...hardFieldError.error, details: { field: 'nope', attempts: 1 } },
    };
    expect(FieldStateSchema.safeParse(unknownFieldError).success).toBe(false);
  });
});

describe('events / outbox topics', () => {
  // B-30 评审事件 topic 单一权威（Codex#11-r4）：50/70/shared 必须同名为 notify.review_decided。
  // 旧分裂名 capability.review_resolved 绝不复活（防回归再次劈成两 topic）。
  it('canonical review topic = notify.review_decided (never the old capability.review_resolved)', () => {
    expect(OutboxTopicSchema.safeParse('notify.review_decided').success).toBe(true);
    expect(OutboxTopicSchema.safeParse('capability.review_resolved').success).toBe(false);
    expect(ACTIVE_OUTBOX_TOPICS).toContain('notify.review_decided');
  });

  it('every ACTIVE topic is a typed OutboxTopic with a TOPIC_CLASS mapping', () => {
    for (const t of ACTIVE_OUTBOX_TOPICS) {
      expect(OutboxTopicSchema.safeParse(t).success).toBe(true);
      expect(TOPIC_CLASS[t]).toBeDefined();
    }
  });

  it('TOPIC_CLASS covers all topics; notify.review_decided is class notify', () => {
    for (const t of OutboxTopicSchema.options) {
      expect(TOPIC_CLASS[t]).toBeDefined();
    }
    expect(TOPIC_CLASS['notify.review_decided']).toBe('notify');
  });

  // P1：ConsumerCursor.topic 列须容纳 lifecycle 合并 cursor 字面量 'capability.*'（与运行时写入一致），
  //   否则 schema 与运行时游标取值冲突（P0-2 合并 cursor 单行游标）。
  it('ConsumerCursorTopicSchema accepts real OutboxTopics AND the merged lifecycle cursor key', () => {
    expect(MERGED_LIFECYCLE_CURSOR_TOPIC).toBe('capability.*');
    // 真实子 topic（notify 各拆一行游标）通过。
    expect(ConsumerCursorTopicSchema.safeParse('notify.import_completed').success).toBe(true);
    expect(ConsumerCursorTopicSchema.safeParse('capability.published').success).toBe(true);
    // 合并 cursor key（lifecycle 合并流单行游标，运行时写入值）通过——本期修复点。
    expect(ConsumerCursorTopicSchema.safeParse('capability.*').success).toBe(true);
    expect(ConsumerCursorTopicSchema.safeParse(MERGED_LIFECYCLE_CURSOR_TOPIC).success).toBe(true);
    // 非法字面量仍被拒。
    expect(ConsumerCursorTopicSchema.safeParse('capability.bogus').success).toBe(false);
  });

  it('ConsumerCursorSchema parses a merged-lifecycle cursor row (topic = capability.*)', () => {
    const ok = ConsumerCursorSchema.safeParse({
      consumerName: 'MarketplaceProjection',
      topic: 'capability.*',
      lastSeq: 42,
      lastEventId: '01J-evt',
      updatedAt: '2026-06-16T00:00:00Z',
    });
    expect(ok.success).toBe(true);
  });

  it('NotifyReviewDecidedPayload accepts the authoritative review-decided payload', () => {
    const ok = NotifyReviewDecidedPayloadSchema.safeParse({
      recipientId: 'u1',
      capabilityId: 'cap1',
      versionId: 'v1',
      decision: 'rejected',
      rejectReason: '标题不够清晰',
      link: '/creator/builder?capabilityId=cap1',
      traceId: '01J-trace',
      occurredAt: '2026-06-16T00:00:00Z',
    });
    expect(ok.success).toBe(true);
  });
});

// 全量 outbox topic × payload 一致性自核验（Codex r5 防再漏）：
//   shared events.ts 是【已实现真源】，50/60/70 契约描述必须字段级对齐到它。
//   下表枚举每个 active topic 的权威 payload 形态（= 70 §7 / shared），逐一断言：
//   ① 权威完整 payload 通过；② 旧/错形态被拒（capability.unpublished 不再接受 versionId/review_rejected）。
describe('events / payload consistency sweep (every outbox topic)', () => {
  const ISO = '2026-06-16T00:00:00+00:00';

  it('capability.published — full authoritative payload parses; isRollback/ownerUserId required', () => {
    const full = {
      capabilityId: 'cap1',
      versionId: 'v1',
      slug: 'my-capability',
      manifestHash: 'sha256:abc',
      reviewStatus: 'alpha_pending',
      isRollback: false,
      ownerUserId: 'u1',
      traceId: '01J-trace',
      occurredAt: ISO,
    };
    expect(CapabilityPublishedPayloadSchema.safeParse(full).success).toBe(true);
    // rollback 路径（评审拒绝回退上一版）：isRollback=true + published。
    expect(
      CapabilityPublishedPayloadSchema.safeParse({
        ...full,
        isRollback: true,
        reviewStatus: 'published',
      }).success,
    ).toBe(true);
    // 旧契约缺 isRollback/ownerUserId/traceId/occurredAt（50 旧 `{versionId,reviewStatus,visibility,slug,manifestHash}`）→ 拒。
    expect(
      CapabilityPublishedPayloadSchema.safeParse({
        versionId: 'v1',
        reviewStatus: 'alpha_pending',
        slug: 'my-capability',
        manifestHash: 'sha256:abc',
      }).success,
    ).toBe(false);
  });

  it('capability.unpublished — authoritative reason=review_rejected_no_prev; old shape rejected', () => {
    const ok = CapabilityUnpublishedPayloadSchema.safeParse({
      capabilityId: 'cap1',
      reason: 'review_rejected_no_prev',
      ownerUserId: 'u1',
      traceId: '01J-trace',
      occurredAt: ISO,
    });
    expect(ok.success).toBe(true);
    // 旧 50 契约 `{ versionId, reason:'review_rejected' }` 必须被拒（reason 字面量已收紧 + 缺字段）。
    expect(
      CapabilityUnpublishedPayloadSchema.safeParse({ versionId: 'v1', reason: 'review_rejected' })
        .success,
    ).toBe(false);
    // 仅 reason 字面量错（其余齐全）也拒。
    expect(
      CapabilityUnpublishedPayloadSchema.safeParse({
        capabilityId: 'cap1',
        reason: 'review_rejected',
        ownerUserId: 'u1',
        traceId: '01J-trace',
        occurredAt: ISO,
      }).success,
    ).toBe(false);
  });

  it('notify.import_completed — base(recipientId/link/traceId/occurredAt) + jobId/attemptNo/snapshotId/segmentCount', () => {
    expect(
      NotifyImportCompletedPayloadSchema.safeParse({
        recipientId: 'u1',
        link: '/creator/builder?step=import',
        traceId: '01J-trace',
        occurredAt: ISO,
        jobId: 'j1',
        attemptNo: 1,
        snapshotId: 'snap1',
        segmentCount: 215,
      }).success,
    ).toBe(true);
  });

  it('notify.extract_completed — base + jobId/attemptNo/candidateCount', () => {
    expect(
      NotifyExtractCompletedPayloadSchema.safeParse({
        recipientId: 'u1',
        link: '/creator/builder?step=extract',
        traceId: '01J-trace',
        occurredAt: ISO,
        jobId: 'j1',
        attemptNo: 1,
        candidateCount: 9,
      }).success,
    ).toBe(true);
  });

  it('notify.publish_completed — base + versionId/capabilityId/reviewStatus=alpha_pending', () => {
    expect(
      NotifyPublishCompletedPayloadSchema.safeParse({
        recipientId: 'u1',
        link: '/creator/builder?step=publish',
        traceId: '01J-trace',
        occurredAt: ISO,
        versionId: 'v1',
        capabilityId: 'cap1',
        reviewStatus: 'alpha_pending',
      }).success,
    ).toBe(true);
  });

  it('frozen topics (usage.metering / runtime.session_event) keep their frozen schema shape', () => {
    expect(
      UsageMeteringPayloadSchema.safeParse({
        sessionId: 's1',
        turn: 1,
        attempt: 1,
        consumerKey: 'anon-hash',
        tokens: 100,
        costMicros: 5,
        revenueMicros: 8,
        mode: 'paid',
        traceId: '01J-trace',
        occurredAt: ISO,
      }).success,
    ).toBe(true);
    expect(
      RuntimeSessionEventPayloadSchema.safeParse({
        sessionId: 's1',
        phase: 'init',
        traceId: '01J-trace',
        occurredAt: ISO,
      }).success,
    ).toBe(true);
  });

  it('every ACTIVE topic has an exercised payload schema (no topic left unswept)', () => {
    // active = capability.published/unpublished + 四个 notify.*；本块已逐一断言其权威 payload。
    const sweptActive = new Set([
      'capability.published',
      'capability.unpublished',
      'notify.import_completed',
      'notify.extract_completed',
      'notify.publish_completed',
      'notify.review_decided', // 上一 describe 块断言
    ]);
    for (const t of ACTIVE_OUTBOX_TOPICS) {
      expect(sweptActive.has(t)).toBe(true);
    }
    expect(sweptActive.size).toBe(ACTIVE_OUTBOX_TOPICS.length);
  });
});

describe('OpenAPI', () => {
  it('generates a 3.1 document with all registered component schemas', () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    const schemas = doc.components?.schemas ?? {};
    for (const name of REGISTERED_SCHEMA_NAMES) {
      expect(schemas[name]).toBeDefined();
    }
    expect(schemas['ErrorEnvelope']).toBeDefined();
  });
});
