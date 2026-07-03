// jobs 受保护写入仓库自检（脊柱 §6 / §11.A）：领租约 + fence 防重入 + 取消 + sweeper 重入队。
import { describe, it, expect } from 'vitest';
import {
  claimLease,
  renewLease,
  persistProgress,
  completeJob,
  failJob,
  cancelJob,
  reclaimExpired,
  requeuePending,
  readJobStatus,
  normalizeProgress,
} from '../platform/jobs/repo.js';
import { FakeDb, makeJob, type FakeClock, type FakeJob } from './jobs-fence.js';

function setup(
  jobs: FakeJob[],
  now = 1_000,
): { db: FakeDb; clock: FakeClock; map: Map<string, FakeJob> } {
  const map = new Map(jobs.map((j) => [j.id, j]));
  const clock: FakeClock = { now };
  return { db: new FakeDb(map, clock), clock, map };
}

describe('claimLease（领租约 + fence 换新，脊柱 §6.2）', () => {
  it('queued → 领到租约：status=running、fence+1、attempt+1', async () => {
    const { db, map } = setup([makeJob('j1')]);
    const leased = await claimLease(db, 'j1', 'owner-A', 30_000);
    expect(leased).not.toBeNull();
    expect(leased?.fenceToken).toBe(1);
    expect(leased?.attemptNo).toBe(1);
    expect(map.get('j1')?.status).toBe('running');
    expect(map.get('j1')?.lease_owner).toBe('owner-A');
  });

  it('已被活跃租约持有（lease 未过期）→ 抢不到（返回 null，不抢，脊柱 §6.2）', async () => {
    const { db } = setup([
      makeJob('j1', {
        status: 'running',
        lease_owner: 'owner-A',
        lease_until: 999_999,
        fence_token: 1,
      }),
    ]);
    const second = await claimLease(db, 'j1', 'owner-B', 30_000);
    expect(second).toBeNull();
  });

  it('lease 已过期但【仍占用】(lease_owner 非空)的 running → 递增接管（换新 fence，attempt+1）', async () => {
    const { db, map } = setup(
      [
        makeJob('j1', {
          status: 'running',
          lease_owner: 'owner-A',
          lease_until: 500,
          fence_token: 3,
          attempt_no: 1,
        }),
      ],
      1_000,
    );
    const leased = await claimLease(db, 'j1', 'owner-B', 30_000);
    expect(leased?.fenceToken).toBe(4);
    expect(leased?.attemptNo).toBe(2);
    expect(map.get('j1')?.lease_owner).toBe('owner-B');
  });

  it('已被 reclaimExpired 接管的行(running 无主 + 租约过去) → 只接管租约，不再递增 fence/attempt（Codex P1-r5：不出现 N+2）', async () => {
    const { db, map } = setup(
      [
        // reclaimExpired 已把 N→N+1（fence=2, attempt=2）并置 lease_owner=NULL、lease_until 过去。
        makeJob('j1', {
          status: 'running',
          lease_owner: null,
          lease_until: 0,
          fence_token: 2,
          attempt_no: 2,
        }),
      ],
      1_000,
    );
    const leased = await claimLease(db, 'j1', 'worker-B', 30_000);
    // 关键：claim 返回 reclaim 设定的当前 fence/attempt，绝不 +1（否则就是 r5 报的 N+2、跳号、脱节）。
    expect(leased?.fenceToken).toBe(2);
    expect(leased?.attemptNo).toBe(2);
    const j = map.get('j1')!;
    expect(j.fence_token).toBe(2); // 库里也不变
    expect(j.attempt_no).toBe(2);
    expect(j.lease_owner).toBe('worker-B'); // 仅接管租约
    expect(j.lease_until).toBe(1_000 + 30_000); // 续了租
  });
});

describe('fence 防重入（§11.A：fence 失配 0 行安全退出）', () => {
  it('persistProgress 旧 fence → 0 行（false）；当前 fence → 写入', async () => {
    const { db } = setup([
      makeJob('j1', { status: 'running', fence_token: 5, lease_until: 999_999 }),
    ]);
    const pv = normalizeProgress({ percent: 10, phrase: 'x' });
    expect(await persistProgress(db, 'j1', 4, pv)).toBe(false); // 旧 fence
    expect(await persistProgress(db, 'j1', 5, pv)).toBe(true); // 当前 fence
  });

  it('renewLease 旧 fence → false（被接管 → runner 据此停）', async () => {
    const { db } = setup([
      makeJob('j1', { status: 'running', fence_token: 7, lease_until: 999_999 }),
    ]);
    expect(await renewLease(db, 'j1', 6, 30_000)).toBe(false);
    expect(await renewLease(db, 'j1', 7, 30_000)).toBe(true);
  });

  it('completeJob 旧 fence → 不覆盖（false）；非 running → 不覆盖', async () => {
    const { db, map } = setup([
      makeJob('j1', { status: 'running', fence_token: 2, lease_until: 999_999 }),
    ]);
    const pv = normalizeProgress({ percent: 100, phrase: 'done' });
    expect(await completeJob(db, 'j1', 1, { r: 1 }, pv)).toBe(false);
    expect(map.get('j1')?.status).toBe('running'); // 未被旧执行污染
    expect(await completeJob(db, 'j1', 2, { r: 1 }, pv)).toBe(true);
    expect(map.get('j1')?.status).toBe('completed');
    // 终态后旧执行再写也 0 行（status 已非 running）。
    expect(
      await failJob(db, 'j1', 2, {
        userMessage: 'x',
        action: 'retry',
        retriable: true,
        traceId: 't',
      }),
    ).toBe(false);
  });
});

describe('cancelJob（B-11 取消：标 cancelled + 换 fence，脊柱 §6.1）', () => {
  it('running → cancelled、fence+1（旧执行据新 fence 失效）', async () => {
    const { db, map } = setup([
      makeJob('j1', { status: 'running', fence_token: 3, lease_until: 999_999 }),
    ]);
    const res = await cancelJob(db, 'j1', 'user-1');
    expect(res?.fenceToken).toBe(4); // 换新 fence
    expect(map.get('j1')?.status).toBe('cancelled');
    // 取消后旧执行（持 fence=3）持久化进度 → 0 行（已被 fence out，已生成保留、不再写）。
    expect(
      await persistProgress(db, 'j1', 3, normalizeProgress({ percent: 50, phrase: 'x' })),
    ).toBe(false);
  });

  it('非本人 → 不可取消（null，不暴露存在性）', async () => {
    const { db } = setup([
      makeJob('j1', { status: 'running', owner_user_id: 'user-1', lease_until: 999_999 }),
    ]);
    expect(await cancelJob(db, 'j1', 'attacker')).toBeNull();
  });

  it('已终态 → 不可取消（null，终态不可逆，脊柱 §6.1）', async () => {
    const { db } = setup([makeJob('j1', { status: 'completed' })]);
    expect(await cancelJob(db, 'j1', 'user-1')).toBeNull();
  });
});

describe('reclaimExpired（B-16 sweeper 重入队，脊柱 §6.2）', () => {
  it('仅 worker 持租后过期的 running 被换 fence；未过期不动', async () => {
    const { db, map } = setup(
      [
        // lease_owner 非空 = worker 曾持租 → 过期可被接管。
        makeJob('expired', {
          status: 'running',
          lease_owner: 'w-dead',
          lease_until: 500,
          fence_token: 1,
        }),
        makeJob('fresh', {
          status: 'running',
          lease_owner: 'w-alive',
          lease_until: 999_999,
          fence_token: 1,
        }),
        makeJob('queued', { status: 'queued' }),
      ],
      1_000,
    );
    const reclaimed = await reclaimExpired(db, 50);
    expect(reclaimed.map((r) => r.id)).toEqual(['expired']);
    expect(map.get('expired')?.fence_token).toBe(2); // 换新
    expect(map.get('fresh')?.fence_token).toBe(1); // 未过期不动（lease 未到期不抢）
    // 接管后 lease_owner=NULL + lease_until 置为已过去（now-1s=0），非 NULL（Codex P0-3）。
    expect(map.get('expired')?.lease_owner).toBeNull();
    expect(map.get('expired')?.lease_until).toBe(0);
  });

  it('已接管态（lease_owner IS NULL、lease_until 已过去）不被 reclaimExpired 再接管（不乱跳 fence/attempt，Codex P0-3）', async () => {
    const { db, map } = setup(
      [
        // 已被上一轮接管：lease_owner=NULL，lease_until 已过去 → 不应再 +1 fence。
        makeJob('handed', {
          status: 'running',
          lease_owner: null,
          lease_until: 0,
          fence_token: 2,
          attempt_no: 2,
        }),
      ],
      1_000,
    );
    const reclaimed = await reclaimExpired(db, 50);
    expect(reclaimed).toEqual([]); // lease_owner IS NULL → 不命中 reclaimExpired
    expect(map.get('handed')?.fence_token).toBe(2); // 不变
    expect(map.get('handed')?.attempt_no).toBe(2); // 不变
  });
});

describe('requeuePending（已接管但入队失败、补入队列举，Codex P0-3）', () => {
  it('列举 lease_owner IS NULL 且 lease_until 已过去的 running job，带既有 fence（不改库）', async () => {
    const { db, map } = setup(
      [
        makeJob('pending', {
          status: 'running',
          lease_owner: null,
          lease_until: 0,
          fence_token: 3,
          attempt_no: 2,
        }),
        // 有主（lease_owner 非空）→ 不列举（已被 worker 接走）。
        makeJob('owned', {
          status: 'running',
          lease_owner: 'w-alive',
          lease_until: 0,
          fence_token: 3,
        }),
        // 终态 → 不列举。
        makeJob('done', { status: 'completed', lease_owner: null, lease_until: 0 }),
      ],
      1_000,
    );
    const pending = await requeuePending(db, 50);
    expect(pending.map((p) => p.id)).toEqual(['pending']);
    expect(pending[0]?.fenceToken).toBe(3); // 既有 fence，补入队用它（不再 +1）
    // 只读列举：不改 fence/attempt/lease。
    expect(map.get('pending')?.fence_token).toBe(3);
    expect(map.get('pending')?.attempt_no).toBe(2);
  });
});

describe('readJobStatus（fence-out 区分真取消 vs 接管，Codex P1-4）', () => {
  it('返回当前 status；不存在 → undefined', async () => {
    const { db } = setup([
      makeJob('c', { status: 'cancelled' }),
      makeJob('r', { status: 'running', lease_owner: 'w', lease_until: 999_999 }),
    ]);
    expect(await readJobStatus(db, 'c')).toBe('cancelled');
    expect(await readJobStatus(db, 'r')).toBe('running');
    expect(await readJobStatus(db, 'none')).toBeUndefined();
  });
});

describe('normalizeProgress', () => {
  it('保留 metrics，供前端提取过程态展示多指标', () => {
    const pv = normalizeProgress({
      percent: 42,
      phrase: '处理中',
      metrics: { analyzedSegments: 12, discoveredCandidates: 3 },
    });
    expect(pv.metrics).toEqual({ analyzedSegments: 12, discoveredCandidates: 3 });
  });
});
