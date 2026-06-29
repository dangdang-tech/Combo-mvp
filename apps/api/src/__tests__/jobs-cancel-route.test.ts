// B-11 取消路由 handler 自检：成功取消 200、非本人/不存在 404、换 fence 后 queue.remove + done 帧。
import { describe, it, expect, vi } from 'vitest';
import { jobCancelHandler } from '../routes/jobs-cancel.js';
import { FakeDb, makeJob, type FakeClock, type FakeJob } from './jobs-fence.js';

function makeReqReply(
  jobId: string,
  userId: string | undefined,
  db: FakeDb,
  removed: string[],
  hot: unknown,
) {
  const sent: { code: number; body: unknown } = { code: 0, body: undefined };
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
  };
  const req = {
    id: 'trace-1',
    params: { jobId },
    auth: userId ? { userId } : undefined,
    log: { error: vi.fn(), warn: vi.fn() },
    server: {
      infra: {
        db,
        redisHot: hot,
        queue: {
          remove: async (id: string) => {
            removed.push(id);
          },
        },
      },
    },
  };
  return { req, reply, sent };
}

function setup(jobs: FakeJob[]): { db: FakeDb; map: Map<string, FakeJob> } {
  const map = new Map(jobs.map((j) => [j.id, j]));
  const clock: FakeClock = { now: 1_000 };
  return { db: new FakeDb(map, clock), map };
}

// 假 redisHot：xadd/expire 静默成功（done 帧推流）。
const fakeHot = { xadd: async () => '1-0', expire: async () => 1 };

describe('jobCancelHandler', () => {
  it('running 本人 → 200、status=cancelled、queue.remove 被调、推 done 帧', async () => {
    const { db, map } = setup([
      makeJob('j1', {
        status: 'running',
        owner_user_id: 'u1',
        fence_token: 2,
        lease_until: 999_999,
      }),
    ]);
    const removed: string[] = [];
    const { req, reply, sent } = makeReqReply('j1', 'u1', db, removed, fakeHot);
    await jobCancelHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200);
    expect((sent.body as { data: { status: string } }).data.status).toBe('cancelled');
    expect(map.get('j1')?.status).toBe('cancelled');
    expect(map.get('j1')?.fence_token).toBe(3); // 换 fence
    expect(removed).toEqual(['j1']);
  });

  it('非本人 → 404（不暴露存在性）', async () => {
    const { db, map } = setup([
      makeJob('j1', { status: 'running', owner_user_id: 'u1', lease_until: 999_999 }),
    ]);
    const removed: string[] = [];
    const { req, reply, sent } = makeReqReply('j1', 'attacker', db, removed, fakeHot);
    await jobCancelHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
    expect(map.get('j1')?.status).toBe('running'); // 未被取消
    expect(removed).toEqual([]); // 未触 remove
  });

  it('已终态 → 404（终态不可逆）', async () => {
    const { db } = setup([makeJob('j1', { status: 'completed', owner_user_id: 'u1' })]);
    const removed: string[] = [];
    const { req, reply, sent } = makeReqReply('j1', 'u1', db, removed, fakeHot);
    await jobCancelHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
  });

  it('未登录 → 401', async () => {
    const { db } = setup([makeJob('j1', { status: 'running' })]);
    const removed: string[] = [];
    const { req, reply, sent } = makeReqReply('j1', undefined, db, removed, fakeHot);
    await jobCancelHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(401);
  });
});
