import { describe, it, expect } from 'vitest';
import {
  ERROR_CLASSIFICATION,
  ErrorCode,
  ErrorEnvelopeSchema,
  errorBodyFor,
  envelopeSchema,
  SSE_EVENT_TYPES,
  DonePayloadSchema,
  CreateTaskBodySchema,
  TaskViewSchema,
  ConnectUploadBodySchema,
  CapabilityDefinitionSchema,
  MessageViewSchema,
  SendMessageBodySchema,
} from '../index.js';
import { z } from 'zod';

describe('错误分类表', () => {
  it('每个内部 code 都有完整分类条目（http/retriable/action/人话模板）', () => {
    for (const code of Object.values(ErrorCode)) {
      const c = ERROR_CLASSIFICATION[code];
      expect(c, `missing classification for ${code}`).toBeDefined();
      expect(c.http).toBeGreaterThanOrEqual(400);
      expect(c.userMessageTemplate.length).toBeGreaterThan(0);
      // 人话模板不允许出现内部码/英文报错痕迹。
      expect(c.userMessageTemplate).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });

  it('errorBodyFor 组装的对外信封不含 code 且过 schema', () => {
    const { http, body } = errorBodyFor(ErrorCode.NOT_FOUND, 'trace-1');
    expect(http).toBe(404);
    expect(ErrorEnvelopeSchema.safeParse({ error: body }).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain('NOT_FOUND');
  });

  it('errorBodyFor 支持人话覆盖与 details 透传', () => {
    const { body } = errorBodyFor(ErrorCode.VALIDATION_FAILED, 't', {
      userMessage: '配对码格式不对。',
      details: { field: 'pairingCode' },
    });
    expect(body.userMessage).toBe('配对码格式不对。');
    expect(body.details).toEqual({ field: 'pairingCode' });
  });
});

describe('SSE 帧协议', () => {
  it('事件类型收敛为 7 个', () => {
    expect(SSE_EVENT_TYPES.length).toBe(7);
  });

  it('done 帧只有 succeeded/failed 两种终态', () => {
    expect(DonePayloadSchema.safeParse({ status: 'succeeded' }).success).toBe(true);
    expect(DonePayloadSchema.safeParse({ status: 'running' }).success).toBe(false);
  });
});

describe('任务域 DTO', () => {
  it('建任务必须带幂等键（长度下限挡弱键）', () => {
    expect(CreateTaskBodySchema.safeParse({ idempotencyKey: 'a-strong-key-123' }).success).toBe(
      true,
    );
    expect(CreateTaskBodySchema.safeParse({ idempotencyKey: 'x' }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({}).success).toBe(false);
  });

  it('TaskView 双轴状态：step 无 publish 值', () => {
    const base = {
      id: 't1',
      currentStep: 'extract',
      status: 'succeeded',
      retryCount: 0,
      upload: {
        status: 'processed',
        partsExpected: 3,
        partsLanded: 3,
        pairingExpiresAt: '2026-07-04T12:00:00+08:00',
      },
      capabilityCount: 2,
      createdAt: '2026-07-04T10:00:00+08:00',
      updatedAt: '2026-07-04T11:00:00+08:00',
    };
    expect(TaskViewSchema.safeParse(base).success).toBe(true);
    expect(TaskViewSchema.safeParse({ ...base, currentStep: 'publish' }).success).toBe(false);
  });

  it('助手分片上传：首片就要声明总数', () => {
    const ok = ConnectUploadBodySchema.safeParse({
      pairingCode: 'ABCD-1234',
      partIndex: 0,
      totalParts: 3,
      content: 'hello',
    });
    expect(ok.success).toBe(true);
    expect(
      ConnectUploadBodySchema.safeParse({ pairingCode: 'x', partIndex: 0, content: 'y' }).success,
    ).toBe(false);
  });
});

describe('能力定义契约（生产端写 / 试用端读的唯一缝）', () => {
  it('version=1 且 instructions 非空才合法', () => {
    const ok = CapabilityDefinitionSchema.safeParse({
      version: 1,
      name: '周报整理',
      summary: '把散乱记录整理成结构化周报',
      kind: 'writing',
      instructions: '你是一个周报整理助手……',
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.meta).toEqual({});
    expect(
      CapabilityDefinitionSchema.safeParse({
        version: 2,
        name: 'x',
        summary: '',
        kind: '',
        instructions: 'y',
      }).success,
    ).toBe(false);
  });
});

describe('试用域 DTO', () => {
  it('消息视图：content 是数组（pi 原生分块），严格校验在 runtime 侧', () => {
    const ok = MessageViewSchema.safeParse({
      id: 'm1',
      seq: 1,
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      status: 'completed',
      createdAt: '2026-07-04T10:00:00+08:00',
    });
    expect(ok.success).toBe(true);
    expect(
      MessageViewSchema.safeParse({
        id: 'm1',
        seq: 1,
        role: 'assistant',
        content: 'plain string',
        status: 'completed',
        createdAt: '2026-07-04T10:00:00+08:00',
      }).success,
    ).toBe(false);
  });

  it('发消息请求体拒绝空文本与超长文本', () => {
    expect(SendMessageBodySchema.safeParse({ text: '你好' }).success).toBe(true);
    expect(SendMessageBodySchema.safeParse({ text: '' }).success).toBe(false);
    expect(SendMessageBodySchema.safeParse({ text: 'a'.repeat(20_001) }).success).toBe(false);
  });
});

describe('响应包络', () => {
  it('envelope factory 包 data', () => {
    const schema = envelopeSchema(z.object({ ok: z.boolean() }));
    expect(schema.safeParse({ data: { ok: true } }).success).toBe(true);
  });
});
