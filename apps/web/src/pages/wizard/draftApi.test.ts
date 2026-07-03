// draftApi 单测（P0-2 bootstrap / F-12 selection PATCH / F-15 续传定位）：
//   createDraft 注入 Idempotency-Key + scope=draft.create + POST /drafts + body 形态；
//   getDraft 读单条 GET /drafts/{id}；
//   patchSelection 注入 Idempotency-Key + scope=draft.selection.patch + PATCH 方法 + body 形态；
//   findDraftById 首选单条 GET（命中即回 / 404 直 undefined / 瞬时错误回落 /dashboard/drafts 翻页）。
import { describe, it, expect } from 'vitest';
import type { DraftView, SelectionDraft } from '@cb/shared';
import { createDraft, getDraft, patchSelection, findDraftById, selectionPath } from './draftApi.js';
import { installFetchMock } from '../../test/mockFetch.js';

function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'd1',
    status: 'active',
    currentStep: 'select',
    stepProgress: { percent: 30, phrase: '选择中' },
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-11T00:00:00Z',
    ...over,
  };
}

describe('createDraft（草稿 bootstrap，scope=draft.create）', () => {
  it('POST /drafts，注入 Idempotency-Key + scope=draft.create，空 body（无 title）', async () => {
    const mock = installFetchMock({
      status: 201,
      json: { data: draftView({ currentStep: 'import' }) },
    });
    try {
      const out = await createDraft();
      expect(out.id).toBe('d1');
      const call = mock.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toBe('/api/v1/drafts');
      expect(call.body).toEqual({});
      expect(call.headers['Idempotency-Key']).toBeTruthy();
      expect(call.headers['X-Idempotency-Scope']).toBe('draft.create');
    } finally {
      mock.restore();
    }
  });

  it('带 title → body={title}；可复用 idempotencyKey（重复点新建回放首次草稿）', async () => {
    const mock = installFetchMock({ status: 201, json: { data: draftView() } });
    try {
      await createDraft({ title: '我的能力', idempotencyKey: 'fixed-key' });
      const call = mock.calls[0]!;
      expect(call.body).toEqual({ title: '我的能力' });
      expect(call.headers['Idempotency-Key']).toBe('fixed-key');
    } finally {
      mock.restore();
    }
  });

  it('建草稿失败 → 抛 ApiError（人话 + 退路；不裸露 code）', async () => {
    const mock = installFetchMock({
      status: 500,
      json: {
        error: {
          userMessage: '新建草稿没成功，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 't',
        },
      },
    });
    try {
      await expect(createDraft()).rejects.toMatchObject({
        name: 'ApiError',
        userMessage: '新建草稿没成功，请重试。',
        action: 'retry',
      });
    } finally {
      mock.restore();
    }
  });
});

describe('getDraft（单条 GET 续传 hydrate）', () => {
  it('GET /drafts/{id} → 解包 DraftView（只读、无写命令头）', async () => {
    const mock = installFetchMock({ status: 200, json: { data: draftView({ id: 'dX' }) } });
    try {
      const out = await getDraft('dX');
      expect(out.id).toBe('dX');
      const call = mock.calls[0]!;
      expect(call.method).toBe('GET');
      expect(call.url).toBe('/api/v1/drafts/dX');
      expect(call.headers['X-Idempotency-Scope']).toBeUndefined();
    } finally {
      mock.restore();
    }
  });
});

describe('patchSelection（端点 G）', () => {
  it('PATCH /drafts/{id}/selection，注入 Idempotency-Key + scope，body={selection}', async () => {
    const mock = installFetchMock({ status: 200, json: { data: draftView() } });
    try {
      const sel: SelectionDraft = { mode: 'single', candidateId: 'c1' };
      const out = await patchSelection('d1', sel);
      expect(out.id).toBe('d1');
      const call = mock.calls[0]!;
      expect(call.method).toBe('PATCH');
      expect(call.url).toBe('/api/v1/drafts/d1/selection');
      expect(call.body).toEqual({ selection: sel });
      // 写命令必带幂等头（脊柱 §4 / 硬规则③）。
      expect(call.headers['Idempotency-Key']).toBeTruthy();
      expect(call.headers['X-Idempotency-Scope']).toBe('draft.selection.patch');
    } finally {
      mock.restore();
    }
  });

  it('可复用 idempotencyKey（重复保存安全，PATCH 最后写赢）', async () => {
    const mock = installFetchMock({ status: 200, json: { data: draftView() } });
    try {
      await patchSelection('d1', { mode: 'all', candidateIds: ['c1', 'c2'] }, 'fixed-key');
      expect(mock.calls[0]!.headers['Idempotency-Key']).toBe('fixed-key');
    } finally {
      mock.restore();
    }
  });

  it('selectionPath 对 draftId 做 URL 编码', () => {
    expect(selectionPath('a/b')).toBe('/drafts/a%2Fb/selection');
  });

  it('失败 → 抛 ApiError（人话 + 退路；不裸露 code）', async () => {
    const mock = installFetchMock({
      status: 403,
      json: {
        error: {
          userMessage: '你没有权限修改这个草稿。',
          retriable: false,
          action: 'escalate',
          traceId: 't1',
        },
      },
    });
    try {
      await expect(
        patchSelection('d1', { mode: 'single', candidateId: 'c1' }),
      ).rejects.toMatchObject({
        name: 'ApiError',
        userMessage: '你没有权限修改这个草稿。',
        action: 'escalate',
      });
    } finally {
      mock.restore();
    }
  });
});

describe('findDraftById（F-15 续传定位，首选单条 GET）', () => {
  it('单条 GET 命中 → 返回该 DraftView（不翻列表）', async () => {
    const mock = installFetchMock({ status: 200, json: { data: draftView({ id: 'd1' }) } });
    try {
      const d = await findDraftById('d1');
      expect(d?.id).toBe('d1');
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.url).toBe('/api/v1/drafts/d1');
    } finally {
      mock.restore();
    }
  });

  it('单条 GET 404（不存在/越权/已终态）→ undefined，不徒劳翻列表', async () => {
    const mock = installFetchMock({
      status: 404,
      json: {
        error: {
          userMessage: '没找到这条草稿，可能已被放弃或不存在。',
          retriable: false,
          action: 'change_input',
          traceId: 't',
        },
      },
    });
    try {
      const d = await findDraftById('missing');
      expect(d).toBeUndefined();
      // 仅单条 GET，未回落列表。
      expect(mock.calls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  it('单条 GET 瞬时 500 → 回落 /dashboard/drafts 翻页定位（第二页命中带 cursor）', async () => {
    const mock = installFetchMock([
      // 单条 GET 瞬时失败（500，retriable）。
      {
        status: 500,
        json: {
          error: {
            userMessage: '读取草稿没成功，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      },
      // 回落列表第一页（未命中、有下一页）。
      {
        status: 200,
        json: {
          data: [draftView({ id: 'a' })],
          meta: { page: { hasMore: true, nextCursor: 'cur2', limit: 20, order: 'desc' } },
        },
      },
      // 列表第二页（命中）。
      {
        status: 200,
        json: {
          data: [draftView({ id: 'd1' })],
          meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
        },
      },
    ]);
    try {
      const d = await findDraftById('d1');
      expect(d?.id).toBe('d1');
      expect(mock.calls).toHaveLength(3);
      expect(mock.calls[0]!.url).toBe('/api/v1/drafts/d1');
      expect(mock.calls[1]!.url).toContain('/dashboard/drafts');
      expect(mock.calls[2]!.url).toContain('cursor=cur2');
    } finally {
      mock.restore();
    }
  });

  it('单条 GET 瞬时错误 + 列表也找不到 → undefined（上层落退路，不裸崩）', async () => {
    const mock = installFetchMock([
      {
        status: 500,
        json: {
          error: {
            userMessage: '读取草稿没成功，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      },
      {
        status: 200,
        json: {
          data: [draftView({ id: 'a' })],
          meta: { page: { hasMore: false, nextCursor: null, limit: 20, order: 'desc' } },
        },
      },
    ]);
    try {
      const d = await findDraftById('missing');
      expect(d).toBeUndefined();
    } finally {
      mock.restore();
    }
  });
});
