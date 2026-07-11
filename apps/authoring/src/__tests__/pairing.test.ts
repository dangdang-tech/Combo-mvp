// 配对上传自检：验码、分片登记、收齐自动流转。忠实假 PG + 假对象存储/队列。
import { describe, it, expect } from 'vitest';
import {
  createTask,
  purgeExpiredUploadParts,
  reconcileExpiredUploadTasks,
} from '../modules/task/service.js';
import {
  RAW_BUCKET,
  landPart,
  partObjectKey,
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
  it('单片即收齐：分片留在桶里不拼接、uploads 置 raw、任务流转 extract、恰好入队一次', async () => {
    const { deps, taskId, code } = await setup();
    const out = await landPart(deps, {
      pairingCode: code,
      partIndex: 0,
      totalParts: 1,
      content: 'hello world',
      traceId: 'tr',
    });
    expect(out).toEqual({ kind: 'ok', result: { landed: 1, total: 1, complete: true } });
    expect(await deps.objectStore.getObjectText(RAW_BUCKET, partObjectKey(taskId, 0))).toBe(
      'hello world',
    );
    // 收齐不再产出拼接后的完整原始件（issue #25：全量拼接曾把 api 进程内存撑爆）。
    await expect(
      deps.objectStore.getObjectText(RAW_BUCKET, `uploads/${taskId}/raw.txt`),
    ).rejects.toThrow();
    const upload = deps.db.uploads.get(taskId)!;
    expect(upload.status).toBe('raw');
    expect(upload.storage_key).toBeNull();
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
    // 三个分片各自留在桶里，worker 逐片消费，不做拼接。
    for (const i of [0, 1, 2]) {
      expect(await deps.objectStore.getObjectText(RAW_BUCKET, partObjectKey(taskId, i))).toBe(
        `p${i}`,
      );
    }
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

  it('putObject 后登记恰逢过期：返回 expired 并 best-effort 删除未登记孤儿 key', async () => {
    const { deps, taskId, code } = await setup();
    const originalQuery = deps.db.query.bind(deps.db);
    deps.db.query = async (...args: Parameters<typeof deps.db.query>) => {
      const sql = args[0].replace(/\s+/g, ' ').trim();
      if (sql.includes('jsonb_build_object')) {
        deps.db.uploads.get(taskId)!.pairing_expires_at = new Date(Date.now() - 1).toISOString();
      }
      return originalQuery(...args);
    };

    const out = await landPart(deps, {
      pairingCode: code,
      partIndex: 0,
      totalParts: 2,
      content: 'orphan candidate',
      traceId: 't-expire-after-put',
    });

    expect(out.kind).toBe('expired');
    await expect(
      deps.objectStore.getObjectText(RAW_BUCKET, partObjectKey(taskId, 0)),
    ).rejects.toThrow();
    expect(deps.db.uploads.get(taskId)!.parts).toEqual({});
  });

  it('孤儿 key 立即删除失败仍持久追踪，worker 下一轮真删并打清理戳', async () => {
    const { deps, taskId, code } = await setup();
    const originalQuery = deps.db.query.bind(deps.db);
    deps.db.query = async (...args: Parameters<typeof deps.db.query>) => {
      const sql = args[0].replace(/\s+/g, ' ').trim();
      if (sql.includes('jsonb_build_object')) {
        deps.db.uploads.get(taskId)!.pairing_expires_at = new Date(Date.now() - 1).toISOString();
      }
      return originalQuery(...args);
    };
    const realDelete = deps.objectStore.delete.bind(deps.objectStore);
    deps.objectStore.delete = async () => {
      throw new Error('minio unavailable');
    };

    const out = await landPart(deps, {
      pairingCode: code,
      partIndex: 0,
      totalParts: 2,
      content: 'still return expired',
      traceId: 't-orphan-delete-failed',
    });

    expect(out.kind).toBe('expired');
    await expect(
      deps.objectStore.getObjectText(RAW_BUCKET, partObjectKey(taskId, 0)),
    ).resolves.toBe('still return expired');
    expect(deps.db.uploads.get(taskId)!.meta).toMatchObject({
      expired_orphan_keys: [partObjectKey(taskId, 0)],
      expired_cleanup_version: 1,
    });

    expect(await reconcileExpiredUploadTasks(deps.db, { traceId: 't-orphan-reconcile' })).toBe(1);
    expect(deps.db.uploads.get(taskId)!.status).toBe('expired');
    deps.objectStore.delete = realDelete;

    await expect(purgeExpiredUploadParts(deps.db, deps.objectStore)).resolves.toEqual({
      purged: 1,
      failedTaskIds: [],
    });
    await expect(
      deps.objectStore.getObjectText(RAW_BUCKET, partObjectKey(taskId, 0)),
    ).rejects.toThrow();
    expect(deps.db.uploads.get(taskId)!.raw_purged_at).not.toBeNull();
  });
});
