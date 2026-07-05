// 配对上传自检：验码、分片登记、收齐自动流转。忠实假 PG + 假对象存储/队列。
import { describe, it, expect } from 'vitest';
import { createTask } from '../modules/task/service.js';
import {
  RAW_BUCKET,
  landPart,
  rawObjectKey,
  verifyPairingCode,
  type LandPartDeps,
} from '../modules/task/pairing.js';
import { FakeDb, FakeObjectStore, FakeQueue } from './fakes.js';

const OWNER = 'user-me';

async function setup(): Promise<{
  deps: LandPartDeps & { objectStore: FakeObjectStore; queue: FakeQueue; db: FakeDb };
  taskId: string;
  code: string;
}> {
  const db = new FakeDb();
  const out = await createTask(db, db, { ownerUserId: OWNER, idempotencyKey: 'idem-key-000001' });
  if (out.kind !== 'ok') throw new Error('seed failed');
  return {
    deps: { db, objectStore: new FakeObjectStore(), queue: new FakeQueue() },
    taskId: out.taskId,
    code: out.pairingCode,
  };
}

describe('verifyPairingCode', () => {
  it('乱码 → invalid；过期 → expired', async () => {
    const { deps, taskId, code } = await setup();
    expect(await verifyPairingCode(deps.db, 'ZZZZ-0000')).toEqual({ ok: false, reason: 'invalid' });
    deps.db.uploads.get(taskId)!.pairing_expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await verifyPairingCode(deps.db, code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('码归一大小写：小写抄码也能过', async () => {
    const { deps, code } = await setup();
    const v = await verifyPairingCode(deps.db, code.toLowerCase());
    expect(v.ok).toBe(true);
  });
});

describe('landPart', () => {
  it('单片即收齐：拼出 raw.txt、uploads 置 raw、任务流转 extract、恰好入队一次', async () => {
    const { deps, taskId, code } = await setup();
    const out = await landPart(deps, {
      pairingCode: code,
      partIndex: 0,
      totalParts: 1,
      content: 'hello world',
      traceId: 'tr',
    });
    expect(out).toEqual({ kind: 'ok', result: { landed: 1, total: 1, complete: true } });
    expect(await deps.objectStore.getObjectText(RAW_BUCKET, rawObjectKey(taskId))).toBe(
      'hello world',
    );
    expect(deps.db.uploads.get(taskId)!.status).toBe('raw');
    const task = deps.db.tasks.get(taskId)!;
    expect(task.current_step).toBe('extract');
    expect(task.status).toBe('running');
    expect(deps.queue.enqueued).toHaveLength(1);
  });

  it('多片乱序 + 重复片幂等：计数正确、收齐才流转', async () => {
    const { deps, taskId, code } = await setup();
    const send = (partIndex: number) =>
      landPart(deps, {
        pairingCode: code,
        partIndex,
        totalParts: 3,
        content: `p${partIndex}`,
        traceId: 't',
      });

    const first = await send(2);
    expect(first).toMatchObject({ kind: 'ok', result: { landed: 1, total: 3, complete: false } });
    const dup = await send(2); // 重复片：覆盖登记，不多计数
    expect(dup).toMatchObject({ kind: 'ok', result: { landed: 1, complete: false } });
    await send(0);
    const last = await send(1);
    expect(last).toMatchObject({ kind: 'ok', result: { landed: 3, total: 3, complete: true } });
    // 按 index 序拼接。
    expect(await deps.objectStore.getObjectText(RAW_BUCKET, rawObjectKey(taskId))).toBe(
      'p0\np1\np2',
    );
    expect(deps.queue.enqueued).toHaveLength(1); // 只入队一次
  });

  it('partIndex 越界 → bad_part；收齐后再传 → expired（码已完成使命）', async () => {
    const { deps, code } = await setup();
    expect(
      (
        await landPart(deps, {
          pairingCode: code,
          partIndex: 5,
          totalParts: 3,
          content: 'x',
          traceId: 't',
        })
      ).kind,
    ).toBe('bad_part');
    await landPart(deps, {
      pairingCode: code,
      partIndex: 0,
      totalParts: 1,
      content: 'done',
      traceId: 't',
    });
    expect(
      (
        await landPart(deps, {
          pairingCode: code,
          partIndex: 0,
          totalParts: 1,
          content: 'again',
          traceId: 't',
        })
      ).kind,
    ).toBe('expired');
  });
});
