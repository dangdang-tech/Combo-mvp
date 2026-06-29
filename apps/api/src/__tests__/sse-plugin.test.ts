// SSE 协议自检（脊柱 §5 / Codex#3）：握手 + 连接即 state_snapshot + Last-Event-ID 恢复 + 帧格式。
//   用最小 mock reply/req（捕获 raw.write）验证真协议，无需真实 socket。
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  startSseStream,
  writeSseFrame,
  getLastEventId,
  type ReplayResult,
} from '../plugins/sse.js';
import type { StateSnapshotPayload } from '@cb/shared';

/** 捕获写入的最小 raw stream。 */
function makeRaw() {
  const writes: string[] = [];
  return {
    writes,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  };
}

function makeReplyReq() {
  const raw = makeRaw();
  const reqRaw = new EventEmitter();
  const reply = { raw, hijack: vi.fn() } as unknown as Parameters<typeof startSseStream>[1];
  const req = { raw: reqRaw } as unknown as Parameters<typeof startSseStream>[0];
  return { reply, req, raw, reqRaw };
}

const jobSnapshot: StateSnapshotPayload = {
  kind: 'job',
  progress: { percent: 0, phrase: '正在准备…', subtasks: [] },
};

describe('SSE frame format (脊柱 §5.3)', () => {
  it('writeSseFrame emits id/event/data with trailing blank line', () => {
    const raw = makeRaw();
    writeSseFrame({ raw } as never, {
      id: '1718-0',
      event: 'progress',
      payload: { percent: 42 },
    });
    const out = raw.writes.join('');
    expect(out).toContain('id: 1718-0');
    expect(out).toContain('event: progress');
    expect(out).toContain('data: {"percent":42}');
    expect(out.endsWith('\n\n')).toBe(true);
  });
});

describe('getLastEventId (脊柱 §5.4)', () => {
  it('reads last-event-id header', () => {
    expect(getLastEventId({ headers: { 'last-event-id': 'abc' } } as never)).toBe('abc');
    expect(getLastEventId({ headers: {} } as never)).toBeUndefined();
  });
});

describe('startSseStream handshake (脊柱 §5.2 / §5.4)', () => {
  it('writes SSE headers + hijacks + first frame = state_snapshot when no Last-Event-ID', async () => {
    const { reply, req, raw } = makeReplyReq();
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
    });
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
    );
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    expect(out).toContain('"kind":"job"');
    handle.stop();
  });

  it('合成 state_snapshot 帧带 id = 订阅锚点（Codex r5 非阻塞③：Last-Event-ID 续传锚点一致）', async () => {
    const { reply, req, raw } = makeReplyReq();
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribeFromId: '777-3', // 调用方建流前抓取的流最新 id（锚点）
    });
    const out = raw.writes.join('');
    // snapshot 帧在 event 之前带 id（合成帧不再裸发、可作 Last-Event-ID 续传锚点）。
    expect(out).toMatch(/id: 777-3\nevent: state_snapshot/);
    handle.stop();
  });

  it('无 subscribeFromId 时合成 snapshot 帧 id 回落 0-0（合法：从头补，保守不漏）', async () => {
    const { reply, req, raw } = makeReplyReq();
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
    });
    const out = raw.writes.join('');
    expect(out).toMatch(/id: 0-0\nevent: state_snapshot/);
    handle.stop();
  });

  it('Last-Event-ID in window → replays increments, NO snapshot (脊柱 §5.4)', async () => {
    const { reply, req, raw } = makeReplyReq();
    const replaySince = async (): Promise<ReplayResult> => ({
      inWindow: true,
      frames: [{ id: '10-0', event: 'progress', payload: { percent: 80 } }],
    });
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      lastEventId: '9-0',
      replaySince,
      loadSnapshot: async () => jobSnapshot,
    });
    const out = raw.writes.join('');
    expect(out).toContain('event: progress');
    expect(out).toContain('id: 10-0');
    // 在窗口内续传：不重推 snapshot。
    expect(out).not.toContain('event: state_snapshot');
    handle.stop();
  });

  it('Last-Event-ID out of window → falls back to state_snapshot (脊柱 §5.4)', async () => {
    const { reply, req, raw } = makeReplyReq();
    const replaySince = async (): Promise<ReplayResult> => ({ inWindow: false, frames: [] });
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      lastEventId: 'ancient-0',
      replaySince,
      loadSnapshot: async () => jobSnapshot,
    });
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot');
    handle.stop();
  });

  it('client disconnect (req close) stops the stream', async () => {
    const { reply, req, raw, reqRaw } = makeReplyReq();
    await startSseStream(req, reply, { kind: 'job', loadSnapshot: async () => jobSnapshot });
    reqRaw.emit('close');
    expect(raw.end).toHaveBeenCalled();
  });

  it('push after stop is a no-op (no write to closed stream)', async () => {
    const { reply, req, raw } = makeReplyReq();
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
    });
    const before = raw.writes.length;
    handle.stop();
    handle.push({ event: 'progress', payload: { percent: 100 } });
    expect(raw.writes.length).toBe(before);
  });

  it('持续订阅（Codex P0-1）：subscribe 被调用并带 fromId；push 的帧写到流上', async () => {
    const { reply, req, raw } = makeReplyReq();
    let seenFromId: string | undefined;
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribeFromId: '500-0', // snapshot 路径：调用方抓的流最新 id
      subscribe: ({ fromId, onFrame }) => {
        seenFromId = fromId;
        onFrame({ id: '600-0', event: 'progress', payload: { percent: 33 } });
      },
    });
    // 让 fire-and-forget 订阅微任务跑完。
    await new Promise((r) => setTimeout(r, 0));
    expect(seenFromId).toBe('500-0'); // 用调用方提供的订阅起点
    const out = raw.writes.join('');
    expect(out).toContain('event: state_snapshot'); // 首帧 snapshot
    expect(out).toContain('id: 600-0'); // 订阅 push 的后续帧
    expect(out).toContain('"percent":33');
    handle.stop();
  });

  it('收到 done 终态帧 → 自动关流（Codex P0-1：终态后关流）', async () => {
    const { reply, req, raw } = makeReplyReq();
    await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribe: ({ onFrame }) => {
        onFrame({ id: '700-0', event: 'done', payload: { status: 'completed' } });
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(out).toContain('event: done');
    expect(raw.end).toHaveBeenCalled(); // done → 关流
  });

  it('客户端断开 → 订阅 signal 被 abort（清理 reader，不泄漏）', async () => {
    const { reply, req, reqRaw } = makeReplyReq();
    let sawAbort = false;
    await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribe: ({ signal }) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
        });
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    reqRaw.emit('close');
    expect(sawAbort).toBe(true);
  });

  it('心跳发【具名 heartbeat 帧】+ data:{ts}（不是 SSE comment : hb，Codex#5）', async () => {
    vi.useFakeTimers();
    try {
      const { reply, req, raw } = makeReplyReq();
      const handle = await startSseStream(req, reply, {
        kind: 'job',
        loadSnapshot: async () => jobSnapshot,
        heartbeatMs: 1000,
      });
      // 推进一个心跳周期。
      await vi.advanceTimersByTimeAsync(1000);
      const out = raw.writes.join('');
      expect(out).toContain('event: heartbeat'); // 具名事件，前端 EventSource 收得到
      expect(out).toMatch(/data: \{"ts":\d+\}/); // 带 {ts} payload
      expect(out).not.toContain(': hb'); // 不再用不可观测的 SSE comment
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startSseStream 统一终态闸（Codex P0-r4：四路径各发一次终态、不悬挂、非 running 不 subscribe）', () => {
  /** 统计 `event: done` 出现次数（双 done 回归守门）。 */
  function countDone(out: string): number {
    return out.split('event: done').length - 1;
  }
  /** 统计 `event: error` 出现次数（双 error 回归守门）。 */
  function countError(out: string): number {
    return out.split('event: error').length - 1;
  }

  it('(a) DB 终态但 replay 在窗口内未含 done → 补发一次 done、关流、绝不 subscribe', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    // replay 在窗口内，但只回放到 progress（没回放到 done，Redis done 尽力而为丢了）。
    const replaySince = async (): Promise<ReplayResult> => ({
      inWindow: true,
      frames: [{ id: '20-0', event: 'progress', payload: { percent: 100 } }],
    });
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      lastEventId: '19-0',
      replaySince,
      loadSnapshot: async () => jobSnapshot,
      subscribe: () => {
        subscribed = true;
      },
      // DB snapshot 已终态 completed → 终态闸据此补发 done。
      terminalFrames: () => [{ event: 'done', payload: { status: 'completed' } }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(out).toContain('id: 20-0'); // 窗口内增量
    expect(out).not.toContain('event: state_snapshot'); // 窗口内不重推 snapshot
    expect(countDone(out)).toBe(1); // 终态闸补发的那一次
    expect(out).toContain('"status":"completed"');
    expect(raw.end).toHaveBeenCalled(); // done → 关流
    expect(subscribed).toBe(false); // 非 running：绝不 subscribe
    handle.stop();
  });

  it('(b) replay 已含 done → 发一次 done、不补、绝不 subscribe（杜绝双 done）', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    const replaySince = async (): Promise<ReplayResult> => ({
      inWindow: true,
      frames: [
        { id: '30-0', event: 'progress', payload: { percent: 100 } },
        { id: '31-0', event: 'done', payload: { status: 'completed' } },
      ],
    });
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      lastEventId: '29-0',
      replaySince,
      loadSnapshot: async () => jobSnapshot,
      subscribe: () => {
        subscribed = true;
      },
      // DB 也终态：终态闸不能因此再补第二个 done。
      terminalFrames: () => [{ event: 'done', payload: { status: 'completed' } }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(out).toContain('id: 31-0');
    expect(countDone(out)).toBe(1); // 恰好一次（replay 那次），无双 done
    expect(raw.end).toHaveBeenCalled();
    expect(subscribed).toBe(false);
    handle.stop();
  });

  it('(c) Last-Event-ID == done id（replay 增量为空）→ 补发一次 done、不悬挂、不 subscribe', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    // Last-Event-ID 恰是 done 的 id：XRANGE (lastId, +] 把 done 自身排除 → 增量为空，但仍在窗口内。
    const replaySince = async (): Promise<ReplayResult> => ({ inWindow: true, frames: [] });
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      lastEventId: '40-0', // == done id
      replaySince,
      loadSnapshot: async () => jobSnapshot,
      subscribe: () => {
        subscribed = true;
      },
      terminalFrames: () => [{ event: 'done', payload: { status: 'completed' } }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(out).not.toContain('event: state_snapshot'); // 窗口内（增量空但 inWindow）不重推 snapshot
    expect(countDone(out)).toBe(1); // 终态闸据 DB 补发一次（不悬挂心跳）
    expect(raw.end).toHaveBeenCalled();
    expect(subscribed).toBe(false);
    handle.stop();
  });

  it('(d) running → 从锚点 subscribe，收到 done 发一次并关流', async () => {
    const { reply, req, raw } = makeReplyReq();
    let seenFromId: string | undefined;
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribeFromId: '900-0',
      // DB 非终态（running）→ terminalFrames 返回空 → 走 subscribe。
      terminalFrames: () => [],
      subscribe: ({ fromId, onFrame }) => {
        seenFromId = fromId;
        onFrame({ id: '901-0', event: 'progress', payload: { percent: 80 } });
        onFrame({ id: '902-0', event: 'done', payload: { status: 'completed' } });
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(seenFromId).toBe('900-0'); // 从锚点订阅
    expect(out).toContain('event: state_snapshot'); // running 首帧 snapshot
    expect(out).toContain('id: 902-0');
    expect(countDone(out)).toBe(1); // 在线 done 一次
    expect(raw.end).toHaveBeenCalled();
    handle.stop();
  });

  it('DB failed 且 replay 已发 error 但缺收尾 done → 只补 done（不重复 error）、关流', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    const envelope = {
      error: { userMessage: 'x', retriable: false, action: 'contact', traceId: 't' },
    };
    const replaySince = async (): Promise<ReplayResult> => ({
      inWindow: true,
      frames: [{ id: '50-0', event: 'error', payload: envelope }], // 回放到 error，done 丢了/超窗
    });
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      lastEventId: '49-0',
      replaySince,
      loadSnapshot: async () => jobSnapshot,
      subscribe: () => {
        subscribed = true;
      },
      // DB failed 的完整失败序列。
      terminalFrames: () => [
        { event: 'error', payload: envelope },
        { event: 'done', payload: { status: 'failed', error: envelope } },
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(countError(out)).toBe(1); // 只 replay 那一次 error（终态闸丢掉补发的前导 error）
    expect(countDone(out)).toBe(1); // 补发收尾 done 一次
    expect(out).toContain('"status":"failed"');
    expect(raw.end).toHaveBeenCalled();
    expect(subscribed).toBe(false);
    handle.stop();
  });

  it('(e) 合成终态 backfill 帧带 id = 订阅锚点（Codex r5 非阻塞③：不破坏 replay 锚点）', async () => {
    const { reply, req, raw } = makeReplyReq();
    // snapshot 路径建流瞬间 DB 已 completed → 终态闸据 terminalFrames 补发 done（合成帧）。
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribeFromId: '888-0', // 锚点
      terminalFrames: () => [{ event: 'done', payload: { status: 'completed' } }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    // 合成 snapshot 与合成 done 都带锚点 id（前端以此为 Last-Event-ID 重连：从锚点之后补，终态后增量空、仍在窗口内）。
    expect(out).toMatch(/id: 888-0\nevent: state_snapshot/);
    expect(out).toMatch(/id: 888-0\nevent: done/);
    expect(countDone(out)).toBe(1);
    expect(raw.end).toHaveBeenCalled();
    handle.stop();
  });

  it('结构性兜底（Codex r4-P2）：terminalFrames 畸形返回无 done → 仍补一个 done 收尾、绝不 subscribe', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribe: () => {
        subscribed = true;
      },
      // 畸形 DB 帧：非空但没 done（违反调用方约定）。终态闸必须仍以 done 收尾、stop、不 subscribe。
      terminalFrames: () => [{ event: 'error', payload: { error: {} } }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(countDone(out)).toBe(1); // 结构性补的收尾 done
    expect(raw.end).toHaveBeenCalled(); // 关流，不悬挂心跳
    expect(subscribed).toBe(false); // terminal 判定后绝不 subscribe（结构性，不靠 DB 帧含 done）
    handle.stop();
  });
});

describe('startSseStream errorIsTerminal 跨流 error 终态语义（Codex r7 P1：字段级 error 非 job 终态）', () => {
  function countDone(out: string): number {
    return out.split('event: done').length - 1;
  }
  const structureSnapshot: StateSnapshotPayload = {
    kind: 'structure',
    structureState: { versionId: 'v1', fields: [], doneCount: 0, totalCount: 7 },
  };
  /** 软字段级失败 ErrorEnvelope（40 §3.4：details.field ∈ SoftFieldKey）。 */
  const fieldError = {
    error: {
      userMessage: '这个字段没生成出来，可重试、改输入或转人工。',
      retriable: true,
      action: 'escalate' as const,
      traceId: 't-1',
      details: { field: 'goal', attempts: 2 },
    },
  };

  it('结构化（errorIsTerminal=false）running：replay 到字段级 error → 不收口、保持 live subscribe、后续可收 field_done/done', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    let seenFromId: string | undefined;
    // 窗口内 replay 回放到字段级 error（worker 软字段两次失败落 error，Job 仍 running）。
    const replaySince = async (): Promise<ReplayResult> => ({
      inWindow: true,
      frames: [{ id: '60-0', event: 'error', payload: fieldError }],
    });
    const handle = await startSseStream(req, reply, {
      kind: 'structure',
      errorIsTerminal: false, // 结构化：字段级 error 是软事件、非 job 终态
      lastEventId: '59-0',
      replaySince,
      loadSnapshot: async () => structureSnapshot,
      // DB active job 仍 running（非终态）→ terminalFrames 返回空 → 终态仅由 done 决定。
      terminalFrames: () => [],
      subscribe: ({ fromId, onFrame }) => {
        subscribed = true;
        seenFromId = fromId;
        // Job 继续：其它软字段后续成功，最终 done completed（字段级失败不拖垮整 Job）。
        onFrame({ id: '61-0', event: 'field_done', payload: { field: 'tagline', value: 'x' } });
        onFrame({ id: '62-0', event: 'done', payload: { status: 'completed' } });
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    // 字段级 error 透传给前端。
    expect(out).toContain('event: error');
    expect(out).toContain('"field":"goal"');
    // 关键：不被提前收口 —— 仍订阅，订阅起点接在 error 帧 id 之后（不漏不重）。
    expect(subscribed).toBe(true);
    expect(seenFromId).toBe('60-0');
    // 后续真流帧收得到（字段级失败后 Job 继续）。
    expect(out).toContain('event: field_done');
    expect(out).toContain('"field":"tagline"');
    // 终态只由 done 决定，恰好一次（不存在被合成的 done failed）。
    expect(countDone(out)).toBe(1);
    expect(out).toContain('"status":"completed"');
    expect(out).not.toContain('"status":"failed"');
    handle.stop();
  });

  it('反向破坏：同场景若 errorIsTerminal=true（默认）→ replay 到字段级 error 被当终态、合成 done failed、提前关流、绝不 subscribe', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    const replaySince = async (): Promise<ReplayResult> => ({
      inWindow: true,
      frames: [{ id: '60-0', event: 'error', payload: fieldError }],
    });
    const handle = await startSseStream(req, reply, {
      kind: 'structure',
      // errorIsTerminal 缺省 = true（错误配置/回归）：error 被当 job 终态前导。
      lastEventId: '59-0',
      replaySince,
      loadSnapshot: async () => structureSnapshot,
      terminalFrames: () => [],
      subscribe: () => {
        subscribed = true;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    // 守门：errorIsTerminal=true 下该场景【被提前收口】—— 合成 done failed、关流、不订阅。
    expect(countDone(out)).toBe(1);
    expect(out).toContain('"status":"failed"');
    expect(raw.end).toHaveBeenCalled();
    expect(subscribed).toBe(false);
    handle.stop();
  });

  it('结构化 live subscribe：字段级 error 帧（非 replay）也不关流，Job 续跑到 done', async () => {
    const { reply, req, raw } = makeReplyReq();
    const handle = await startSseStream(req, reply, {
      kind: 'structure',
      errorIsTerminal: false,
      loadSnapshot: async () => structureSnapshot,
      subscribeFromId: '70-0',
      terminalFrames: () => [], // running
      subscribe: ({ onFrame }) => {
        onFrame({ id: '71-0', event: 'error', payload: fieldError }); // 字段级失败软事件
        // 关键：error 不关流，下面这帧仍写得进去（push 早退守门 stopped=false）。
        onFrame({ id: '72-0', event: 'field_done', payload: { field: 'role', value: 'y' } });
        onFrame({ id: '73-0', event: 'done', payload: { status: 'completed' } });
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(out).toContain('event: error'); // 字段级 error 透传
    expect(out).toContain('id: 72-0'); // error 之后的帧仍下发（未被 error 关流）
    expect(countDone(out)).toBe(1);
    expect(out).toContain('"status":"completed"');
    expect(raw.end).toHaveBeenCalled(); // 由 done 关流（而非 error）
    handle.stop();
  });

  it('回归：job 流（errorIsTerminal 默认 true）DB failed 失败序列 error→done 关流行为不变', async () => {
    const { reply, req, raw } = makeReplyReq();
    let subscribed = false;
    const envelope = {
      error: { userMessage: 'x', retriable: false, action: 'contact', traceId: 't' },
    };
    const handle = await startSseStream(req, reply, {
      kind: 'job',
      loadSnapshot: async () => jobSnapshot,
      subscribe: () => {
        subscribed = true;
      },
      // DB failed：error 是 job 终态前导，其后紧跟 done。
      terminalFrames: () => [
        { event: 'error', payload: envelope },
        { event: 'done', payload: { status: 'failed', error: envelope } },
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    const out = raw.writes.join('');
    expect(out).toContain('event: error');
    expect(countDone(out)).toBe(1);
    expect(out).toContain('"status":"failed"'); // job 失败终态不变
    expect(raw.end).toHaveBeenCalled(); // error→done 关流不回归
    expect(subscribed).toBe(false);
    handle.stop();
  });
});
