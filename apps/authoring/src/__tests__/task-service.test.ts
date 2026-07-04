// 任务状态机服务自检：transition 乐观锁收口、建任务幂等、失败重试。忠实假 PG，无真库。
import { describe, it, expect } from 'vitest';
import { createTask, retryTask, transition } from '../modules/task/service.js';
import { verifyPairingCode } from '../modules/task/pairing.js';
import { FakeDb, FakeQueue } from './fakes.js';

const OWNER = 'user-me';
const OTHER = 'user-other';

async function seedTask(
  db: FakeDb,
  key = 'idem-key-000001',
): Promise<{ taskId: string; code: string }> {
  const out = await createTask(db, db, { ownerUserId: OWNER, idempotencyKey: key });
  if (out.kind !== 'ok') throw new Error('seed failed');
  return { taskId: out.taskId, code: out.pairingCode };
}

describe('createTask（幂等）', () => {
  it('首次创建：tasks+uploads 各一行，配对码明文只出现在返回值', async () => {
    const db = new FakeDb();
    const out = await createTask(db, db, {
      ownerUserId: OWNER,
      idempotencyKey: 'idem-key-000001',
      description: '第一次上传',
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.replayed).toBe(false);
    expect(out.pairingCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const task = db.tasks.get(out.taskId)!;
    expect(task.current_step).toBe('upload');
    expect(task.status).toBe('running');
    const upload = db.uploads.get(out.taskId)!;
    expect(upload.pairing_code_hash).not.toContain(out.pairingCode); // 库里只有哈希
  });

  it('同 key 同 owner 重试：返回同一任务 + 轮换出的新码可用、旧码作废', async () => {
    const db = new FakeDb();
    const first = await seedTask(db);
    const replay = await createTask(db, db, {
      ownerUserId: OWNER,
      idempotencyKey: 'idem-key-000001',
    });
    expect(replay.kind).toBe('ok');
    if (replay.kind !== 'ok') return;
    expect(replay.replayed).toBe(true);
    expect(replay.taskId).toBe(first.taskId); // 不建第二个任务
    expect(db.tasks.size).toBe(1);
    // 新码生效、旧码作废（哈希被轮换覆盖）。
    expect((await verifyPairingCode(db, replay.pairingCode)).ok).toBe(true);
    expect((await verifyPairingCode(db, first.code)).ok).toBe(false);
  });

  it('同 key 不同 owner → conflict（不暴露他人任务）', async () => {
    const db = new FakeDb();
    await seedTask(db);
    const out = await createTask(db, db, { ownerUserId: OTHER, idempotencyKey: 'idem-key-000001' });
    expect(out.kind).toBe('conflict');
  });
});

describe('transition（状态变更唯一入口，乐观锁）', () => {
  it('期望现态命中才更新；不命中 0 行拒绝、原行不动', async () => {
    const db = new FakeDb();
    const { taskId } = await seedTask(db);
    // 错误的期望现态（任务实际在 upload/running）。
    const miss = await transition(
      db,
      taskId,
      { step: 'extract', status: 'running' },
      { status: 'failed' },
    );
    expect(miss).toBe(false);
    expect(db.tasks.get(taskId)!.status).toBe('running');
    // 正确期望：upload→extract。
    const hit = await transition(
      db,
      taskId,
      { step: 'upload', status: 'running' },
      { step: 'extract' },
    );
    expect(hit).toBe(true);
    expect(db.tasks.get(taskId)!.current_step).toBe('extract');
  });

  it('任何 transition 都清掉租约（执行权随状态变更终结）', async () => {
    const db = new FakeDb();
    const { taskId } = await seedTask(db);
    const t = db.tasks.get(taskId)!;
    t.current_step = 'extract';
    t.lease_owner = 'worker-a#1';
    t.lease_expires_at = new Date(Date.now() + 60_000).toISOString();
    await transition(db, taskId, { step: 'extract', status: 'running' }, { status: 'failed' });
    expect(t.lease_owner).toBeNull();
    expect(t.lease_expires_at).toBeNull();
  });
});

describe('retryTask', () => {
  it('failed 才可重试：retry_count+1、清错误、回 running、extract 步重新入队', async () => {
    const db = new FakeDb();
    const queue = new FakeQueue();
    const { taskId } = await seedTask(db);
    const t = db.tasks.get(taskId)!;
    t.current_step = 'extract';
    t.status = 'failed';
    t.last_error = { userMessage: '上次挂了' };
    const out = await retryTask(db, queue, { taskId, ownerUserId: OWNER, traceId: 'tr' });
    expect(out.kind).toBe('ok');
    expect(t.status).toBe('running');
    expect(t.retry_count).toBe(1);
    expect(t.last_error).toBeNull();
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]!.taskId).toBe(taskId);
  });

  it('running 态不可重试；非 owner 视同不存在', async () => {
    const db = new FakeDb();
    const queue = new FakeQueue();
    const { taskId } = await seedTask(db);
    expect((await retryTask(db, queue, { taskId, ownerUserId: OWNER, traceId: 't' })).kind).toBe(
      'not_retriable',
    );
    expect((await retryTask(db, queue, { taskId, ownerUserId: OTHER, traceId: 't' })).kind).toBe(
      'not_found',
    );
    expect(queue.enqueued).toHaveLength(0);
  });
});
