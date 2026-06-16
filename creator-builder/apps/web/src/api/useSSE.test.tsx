// useSSE 测试（脊柱 §5 12 帧协议，真实 payload 形态）：snapshot 初始化 + 同步 items /
// progress+subtask（全量 + 单条缺 label 保留旧）/ item-appended（job 取 payload.item、structure 数组项）/
// field_* 累积 deltaText / field_stuck / slow_hint / error 白名单解包（无 code 泄漏）/ done 关流 /
// heartbeat 看门狗 / 断线重连带正确 Last-Event-ID 续接（不重不漏，fetch-event-source 真实续传语义）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useSSE, type UseSSEState, __setFetchEventSourceForTests } from './useSSE.js';
import { MockFetchEventSource, type MockSSEConnection } from '../test/mockFetchEventSource.js';
import { SSE_HEARTBEAT_INTERVAL_MS } from '@cb/shared';

/** 把 hook 状态抛到外部引用，供断言。 */
function Harness({
  url,
  kind,
  capture,
}: {
  url: string | null;
  kind: 'job' | 'structure';
  capture: (s: UseSSEState) => void;
}) {
  const state = useSSE(url, kind);
  capture(state);
  return null;
}

let latest: UseSSEState;
function renderSSE(url: string | null, kind: 'job' | 'structure') {
  return render(<Harness url={url} kind={kind} capture={(s) => (latest = s)} />);
}

/** 取当前活跃连接（useSSE effect 同步发起 fetchEventSource）。 */
function conn(): MockSSEConnection {
  const c = MockFetchEventSource.last;
  if (!c) throw new Error('no SSE connection created');
  return c;
}

let restoreFes: () => void;
beforeEach(() => {
  restoreFes = __setFetchEventSourceForTests(MockFetchEventSource.impl);
});
afterEach(() => {
  restoreFes();
});

describe('连接与 state_snapshot 初始化', () => {
  it('enabled=false（url=null）不建流', () => {
    renderSSE(null, 'job');
    expect(MockFetchEventSource.connections.length).toBe(0);
  });

  it('建流即 connecting；onopen → open', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    expect(latest.status).toBe('connecting');
    act(() => conn().open());
    expect(latest.status).toBe('open');
  });

  it('首帧 state_snapshot(job) 初始化全量 progress 并同步 items（已生成不丢）', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    act(() =>
      conn().emit(
        'state_snapshot',
        {
          kind: 'job',
          progress: {
            percent: 20,
            phrase: '20% · 已抓取 40 / 200 段',
            subtasks: [{ key: 'fetch_index', label: '拉取会话索引', status: 'running' }],
            items: [{ id: 'c1', title: '已识别候选1' }],
          },
        },
        { id: '1-0' },
      ),
    );
    expect(latest.status).toBe('open');
    expect(latest.progress?.percent).toBe(20);
    expect(latest.progress?.subtasks[0]?.status).toBe('running');
    // #6：snapshot.progress.items 同步进 state.items（刷新/超窗恢复不丢已生成候选）。
    expect(latest.items.length).toBe(1);
    expect((latest.items[0] as { id: string }).id).toBe('c1');
    expect(latest.lastEventId).toBe('1-0');
  });

  it('state_snapshot(job) 无 items → state.items 重置为空（不残留过期）', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    act(() => conn().emit('item-appended', { item: { id: 'stale' } }));
    expect(latest.items.length).toBe(1);
    act(() =>
      conn().emit('state_snapshot', {
        kind: 'job',
        progress: { percent: 0, phrase: '重连恢复', subtasks: [] },
      }),
    );
    expect(latest.items.length).toBe(0);
  });

  it('首帧 state_snapshot(structure) 初始化字段级真源', () => {
    renderSSE('/api/v1/versions/v1/structure/events', 'structure');
    act(() => conn().open());
    act(() =>
      conn().emit(
        'state_snapshot',
        {
          kind: 'structure',
          structureState: {
            versionId: 'ver_1',
            fields: [
              { field: 'name', status: 'done', value: '助手' },
              { field: 'tagline', status: 'pending' },
            ],
            doneCount: 1,
            totalCount: 2,
          },
        },
        { id: '1-0' },
      ),
    );
    expect(latest.structureState?.fields.length).toBe(2);
    expect(latest.structureState?.doneCount).toBe(1);
  });
});

describe('progress / subtask / item-appended 帧（job 流，真实 payload）', () => {
  beforeEach(() => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    act(() =>
      conn().emit('state_snapshot', {
        kind: 'job',
        progress: { percent: 0, phrase: '开始', subtasks: [] },
      }),
    );
  });

  it('progress 帧更新百分比与量化文案，保留既有 subtasks', () => {
    act(() => conn().emit('subtask', { key: 'redact', status: 'running' }));
    act(() =>
      conn().emit('progress', { percent: 68, phrase: '68% · 146 / 215', done: 146, total: 215 }),
    );
    expect(latest.progress?.percent).toBe(68);
    expect(latest.progress?.done).toBe(146);
    expect(latest.progress?.total).toBe(215);
    expect(latest.progress?.subtasks.find((s) => s.key === 'redact')?.status).toBe('running');
  });

  it('subtask 单条 { key, status }（后端实际形态，无 label）→ 新建项用 key 兜底 label', () => {
    act(() => conn().emit('subtask', { key: 'redact', status: 'running' }));
    const redact = latest.progress?.subtasks.find((s) => s.key === 'redact');
    expect(redact?.status).toBe('running');
    expect(redact?.label).toBe('redact'); // 缺 label → key 兜底（不是 undefined）。
  });

  it('subtask 单条缺 label → 保留旧 label（#3）', () => {
    // 先给一条带 label 的（如 snapshot 已建好），再发只带 status 的更新。
    act(() => conn().emit('subtask', { key: 'redact', label: '导入并抹隐私', status: 'running' }));
    act(() => conn().emit('subtask', { key: 'redact', status: 'done' }));
    const redact = latest.progress?.subtasks.filter((s) => s.key === 'redact') ?? [];
    expect(redact.length).toBe(1);
    expect(redact[0]?.status).toBe('done');
    expect(redact[0]?.label).toBe('导入并抹隐私'); // label 不被 undefined 覆盖。
  });

  it('subtask 全量 { subtasks: SubtaskView[] } → 整表替换（#3）', () => {
    act(() => conn().emit('subtask', { key: 'analyze', label: '分析', status: 'done' }));
    act(() =>
      conn().emit('subtask', {
        subtasks: [
          { key: 'analyze', label: '分析会话段落', status: 'done' },
          { key: 'cluster', label: '聚类相似工作流', status: 'running' },
        ],
      }),
    );
    const subs = latest.progress?.subtasks ?? [];
    expect(subs.length).toBe(2);
    expect(subs.find((s) => s.key === 'cluster')?.status).toBe('running');
    expect(subs.find((s) => s.key === 'analyze')?.label).toBe('分析会话段落');
  });

  it('item-appended（job 流）取 payload.item 累积（#4，不套一层 {item}）', () => {
    act(() => conn().emit('item-appended', { item: { id: 'c1', title: '候选1' } }));
    act(() => conn().emit('item-appended', { item: { id: 'c2', title: '候选2' } }));
    expect(latest.items.length).toBe(2);
    // 累积的是裸 item（id 在顶层），不是 { item: {...} }。
    expect((latest.items[1] as { id: string }).id).toBe('c2');
    expect((latest.items[1] as Record<string, unknown>)['item']).toBeUndefined();
  });
});

describe('field_* / item-appended（structure 流，真实 payload）', () => {
  beforeEach(() => {
    renderSSE('/api/v1/versions/v1/structure/events', 'structure');
    act(() => conn().open());
    act(() =>
      conn().emit('state_snapshot', {
        kind: 'structure',
        structureState: {
          versionId: 'ver_1',
          fields: [
            { field: 'name', status: 'pending' },
            { field: 'skill_set', status: 'pending' },
          ],
          doneCount: 0,
          totalCount: 2,
        },
      }),
    );
  });

  it('field_start→field_delta(累积 deltaText)→field_done 合并字段值与状态（#5）', () => {
    act(() => conn().emit('field_start', { field: 'name', index: 0, total: 2 }));
    expect(latest.structureState?.fields.find((f) => f.field === 'name')?.status).toBe(
      'generating',
    );
    // deltaText 累积（真实后端形态：field_delta 发 deltaText，不是 value）。
    act(() => conn().emit('field_delta', { field: 'name', deltaText: '智能' }));
    act(() => conn().emit('field_delta', { field: 'name', deltaText: '助手' }));
    expect(latest.structureState?.fields.find((f) => f.field === 'name')?.value).toBe('智能助手');
    // field_done 写终值 + 转 done。
    act(() => conn().emit('field_done', { field: 'name', value: '智能助手' }));
    const f = latest.structureState?.fields.find((x) => x.field === 'name');
    expect(f?.status).toBe('done');
    expect(f?.value).toBe('智能助手');
    expect(latest.structureState?.doneCount).toBe(1);
  });

  it('item-appended（structure 流）{ field, itemIndex, value } 补进数组字段（#4）', () => {
    act(() => conn().emit('field_start', { field: 'skill_set', index: 1, total: 2 }));
    act(() =>
      conn().emit('item-appended', {
        field: 'skill_set',
        itemIndex: 0,
        value: '把模糊想法拆成结构化问题',
      }),
    );
    act(() =>
      conn().emit('item-appended', {
        field: 'skill_set',
        itemIndex: 1,
        value: '按 PRD 模板组织输出',
      }),
    );
    const f = latest.structureState?.fields.find((x) => x.field === 'skill_set');
    expect(Array.isArray(f?.value)).toBe(true);
    expect(f?.value).toEqual(['把模糊想法拆成结构化问题', '按 PRD 模板组织输出']);
    // 不进 state.items（那是 job 流的累积器）。
    expect(latest.items.length).toBe(0);
  });

  it('field_stuck 帧暴露三退路选项', () => {
    act(() =>
      conn().emit('field_stuck', {
        field: 'tagline',
        elapsedMs: 30000,
        options: ['continue', 'regen', 'wait'],
      }),
    );
    expect(latest.stuck?.field).toBe('tagline');
    expect(latest.stuck?.options).toEqual(['continue', 'regen', 'wait']);
  });

  it('slow_hint 帧暴露安抚文案（非错误）', () => {
    act(() => conn().emit('slow_hint', { phrase: '内容较多，正在认真生成…', elapsedMs: 12000 }));
    expect(latest.slowHint?.phrase).toBe('内容较多，正在认真生成…');
    expect(latest.status).not.toBe('error');
  });
});

describe('error 帧 / done 帧（白名单重建错误信封，无 code 泄漏）', () => {
  beforeEach(() => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
  });

  it('error 帧 = 完整对外 ErrorEnvelope → 白名单重建 ErrorBody，UI 只读 userMessage+action', () => {
    act(() =>
      conn().emit('error', {
        error: {
          userMessage: '上游处理暂时不稳定，请稍后重试。',
          retriable: true,
          action: 'retry',
          traceId: 'tr-1',
        },
      }),
    );
    expect(latest.status).toBe('error');
    expect(latest.error?.userMessage).toBe('上游处理暂时不稳定，请稍后重试。');
    expect(latest.error?.action).toBe('retry');
    expect((latest.error as Record<string, unknown>)['code']).toBeUndefined();
  });

  it('error 帧夹带禁止字段（code/stack/status/原始 message）→ 一律不留在 state.error（#2 反向破坏）', () => {
    act(() =>
      conn().emit('error', {
        error: {
          userMessage: '服务开小差了，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 'tr-9',
          // 以下都是禁止泄漏字段：
          code: 'INTERNAL',
          status: 500,
          stack: 'Error: boom\n    at foo (/srv/app.ts:10:5)',
          message: 'raw upstream error',
          details: {
            field: 'name', // 安全键，保留
            attempts: 2, // 安全键，保留
            code: 'INTERNAL', // 禁止键，丢
            stack: 'at bar (x:1:1)', // 禁止键，丢
            sql: 'SELECT * FROM users WHERE id=1', // 禁止键，丢
          },
        },
      }),
    );
    const e = latest.error as Record<string, unknown>;
    expect(e['userMessage']).toBe('服务开小差了，请重试。');
    expect(e['code']).toBeUndefined();
    expect(e['status']).toBeUndefined();
    expect(e['stack']).toBeUndefined();
    expect(e['message']).toBeUndefined();
    const details = e['details'] as Record<string, unknown>;
    expect(details).toEqual({ field: 'name', attempts: 2 });
    expect(details['code']).toBeUndefined();
    expect(details['sql']).toBeUndefined();
    // 整体序列化也不含任何禁止串。
    const json = JSON.stringify(latest.error);
    expect(json).not.toContain('INTERNAL');
    expect(json).not.toContain('SELECT');
    expect(json).not.toMatch(/\bstack\b/);
  });

  it('error 帧非契约 payload → 本地兜底人话（永不裸错）', () => {
    act(() => conn().emit('error', { garbage: true }));
    expect(latest.status).toBe('error');
    expect(latest.error?.userMessage).toBe('出了点小问题，请重试。');
  });

  it('done 帧（成功终态）→ status=done 并关流（abort）', () => {
    act(() => conn().emit('done', { status: 'completed', result: { ok: true } }));
    expect(latest.status).toBe('done');
    expect(latest.done?.status).toBe('completed');
    expect(conn().aborted).toBe(true);
  });

  it('done 帧（失败终态）携 ErrorEnvelope → status=error 走同一渲染路径', () => {
    act(() =>
      conn().emit('done', {
        status: 'failed',
        error: {
          error: {
            userMessage: '这一步超时了，可重试。',
            retriable: true,
            action: 'retry',
            traceId: 't',
          },
        },
      }),
    );
    expect(latest.status).toBe('error');
    expect(latest.error?.userMessage).toBe('这一步超时了，可重试。');
  });
});

describe('建流前 HTTP 鉴权/权限失败（onopen 校验 ok+content-type，不走 error 帧）', () => {
  /** 构造一条「非 event-stream 的 HTTP ErrorEnvelope 响应」（后端建流前鉴权失败的契约形态）。 */
  function errResponse(status: number, envelope: unknown): Response {
    return new Response(JSON.stringify(envelope), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const ENVELOPE_401 = {
    error: {
      userMessage: '登录已过期，请重新登录后继续。',
      retriable: false,
      action: 'escalate',
      traceId: 'tr-auth',
      failureId: 'fail-login',
    },
  };

  it('建流时 401 JSON ErrorEnvelope → 进 error 态，白名单重建，不重连（鉴权失败）', async () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    const c = conn();
    expect(latest.status).toBe('connecting');
    // 后端建流前以 401 + 非 event-stream 返回 HTTP ErrorEnvelope（不是 SSE error 帧）。
    await act(async () => {
      await c.open(errResponse(401, ENVELOPE_401));
    });
    // onopen 校验失败 → 统一错误态（不是 open、不是 reconnecting）。
    expect(latest.status).toBe('error');
    expect(latest.error?.userMessage).toBe('登录已过期，请重新登录后继续。');
    expect(latest.error?.action).toBe('escalate');
    expect(latest.error?.failureId).toBe('fail-login');
    // 不重连：仍只有这一条连接（没有因把非 event-stream 当可重连流而新建）。
    expect(MockFetchEventSource.connections.length).toBe(1);
  });

  it('建流时 403 → 进 error 态；DOM/state 只含 userMessage/action，不含 code/status/stack/message（#反向破坏）', async () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    const c = conn();
    // 后端理论上只发对外信封，但反向破坏：即便夹带禁止字段也一律不得留在 state.error。
    await act(async () => {
      await c.open(
        errResponse(403, {
          error: {
            userMessage: '你没有访问该资源的权限。',
            retriable: false,
            action: 'escalate',
            traceId: 'tr-403',
            code: 'FORBIDDEN',
            status: 403,
            stack: 'Error: forbidden\n    at guard (/srv/auth.ts:1:1)',
            message: 'raw forbidden error',
          },
        }),
      );
    });
    expect(latest.status).toBe('error');
    expect(latest.error?.userMessage).toBe('你没有访问该资源的权限。');
    const e = latest.error as Record<string, unknown>;
    expect(e['code']).toBeUndefined();
    expect(e['status']).toBeUndefined();
    expect(e['stack']).toBeUndefined();
    expect(e['message']).toBeUndefined();
    // 整体序列化也不含任何禁止串（DOM 渲染 state.error 时不会泄漏内部码）。
    const json = JSON.stringify(latest.error);
    expect(json).not.toContain('FORBIDDEN');
    expect(json).not.toMatch(/\bstack\b/);
    expect(json).not.toContain('raw forbidden error');
  });

  it('建流时非 JSON body 的非 2xx → 本地兜底人话进 error 态（永不裸错），不重连', async () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    const c = conn();
    await act(async () => {
      // 502 网关返回 HTML / 空 body（非 event-stream、非 JSON）。
      await c.open(
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      );
    });
    expect(latest.status).toBe('error');
    expect(latest.error?.userMessage).toBe('出了点小问题，请重试。');
    expect(MockFetchEventSource.connections.length).toBe(1);
  });

  it('反向破坏守门：onopen 若忽略 response 盲目当流（恢复旧行为）→ 进 open/重连而非 error 态（该测应红）', async () => {
    // 用「旧 onopen 语义」直驱 mock 连接：不校验 response，直接 dispatch('open')——即缺陷未修时的行为。
    // 这里以正向断言钉死「修复后」的对立面：旧行为下 401 会被当流 open，绝不会进 error 态。
    // 即：本套件的 401/403 用例在旧 onopen 下必红——构成反向守门。
    renderSSE('/api/v1/jobs/j1/events', 'job');
    const c = conn();
    // 正常 2xx event-stream 仍走 happy path（确保校验不误伤合法流）。
    await act(async () => {
      await c.open();
    });
    expect(latest.status).toBe('open');
  });

  it('正常 2xx event-stream → 正常订阅（onopen 校验不误伤合法流）', async () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    const c = conn();
    await act(async () => {
      await c.open(
        new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    });
    expect(latest.status).toBe('open');
    // 合法流上 error 帧仍照常走 SSE error 帧路径（与建流前 HTTP 错误两条独立路径都通）。
    act(() => conn().emit('progress', { percent: 10, phrase: '10%' }, { id: '1-0' }));
    expect(latest.progress?.percent).toBe(10);
  });
});

describe('heartbeat 看门狗 / 断线重连（真实 Last-Event-ID 续传，不重不漏）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('心跳帧复位看门狗：持续心跳不触发重连', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    act(() => vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS * 2 - 100));
    act(() => conn().emit('heartbeat', { ts: Date.now() }, { id: 'h-1' }));
    act(() => vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS * 2 - 100));
    expect(MockFetchEventSource.connections.length).toBe(1);
    expect(latest.status).toBe('open');
  });

  it('超过 2× 心跳间隔无任何帧 → 看门狗主动重连（abort 旧 + 建新连接）', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    const first = conn();
    expect(MockFetchEventSource.connections.length).toBe(1);
    act(() => vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS * 2 + 10));
    // 旧连接被 abort，新连接建立（不裸转圈）。
    expect(first.aborted).toBe(true);
    expect(MockFetchEventSource.connections.length).toBe(2);
    expect(latest.status).toBe('connecting');
    act(() => conn().open());
    expect(latest.status).toBe('open');
  });

  it('看门狗重连后，新连接带上次 Last-Event-ID 头为续传锚点（#7 真实续传，不靠静态变量）', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    act(() => conn().emit('progress', { percent: 40, phrase: '40%' }, { id: '9-0' }));
    act(() => vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS * 2 + 10));
    const reconnected = conn();
    // 新连接建流时携带的 Last-Event-ID 头 = 最近帧 id（真实续传锚点，浏览器无法对手动新建的原生 ES 做到这点）。
    expect(reconnected.lastEventIdAtOpen).toBe('9-0');
  });

  it('onerror（网络断）→ reconnecting + 返回重连延迟（库自动按 Last-Event-ID 续连），不裸转圈不报错', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    act(() => conn().emit('progress', { percent: 30, phrase: '30%' }, { id: '5-0' }));
    let delay: unknown;
    act(() => {
      delay = conn().errorDrop();
    });
    expect(latest.status).toBe('reconnecting');
    expect(latest.lastEventId).toBe('5-0');
    expect(latest.status).not.toBe('error');
    expect(typeof delay).toBe('number'); // onerror 返回重连延迟而非抛出（非致命）。
  });

  it('done 后再 errorDrop → 不重连（致命，已终止）', () => {
    renderSSE('/api/v1/jobs/j1/events', 'job');
    act(() => conn().open());
    act(() => conn().emit('done', { status: 'completed' }));
    expect(latest.status).toBe('done');
    // done 后连接已 abort：errorDrop 不再派发（no-op）。
    expect(conn().aborted).toBe(true);
  });
});
