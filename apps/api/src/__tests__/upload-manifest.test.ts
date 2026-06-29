// B-20 直传 manifest 完整性闸 + 原子兑换/建 job + 入队失败留 queued + 同 uploadId 可恢复（Codex P1-r2/P1-r5）。
//   - upload-manifest-repo：persist/read/evaluateManifestGate 判齐 + consumeManifestAndInsertJob 原子 + readJobViewForRecovery。
//   - create-job：createImportJobFromManifest —— enqueue 失败留 queued 交 sweeper（不删/不 503）；同 uploadId 重试恢复同一 job。
import { describe, it, expect } from 'vitest';
import {
  consumeManifestAndInsertJob,
  evaluateManifestGate,
  persistUploadManifest,
  readJobViewForRecovery,
  readUploadManifest,
  type UploadManifest,
} from '../import/upload-manifest-repo.js';
import { createImportJobFromManifest, initialImportProgress } from '../import/create-job.js';
import { reconcileJobsOnce } from '../jobs/sweeper-reconcile.js';
import { ImportFakeDb } from './import-fakes.js';

function manifest(parts: Record<string, string | null>): UploadManifest {
  const expectedParts: UploadManifest['expectedParts'] = {};
  for (const [pid, s3Key] of Object.entries(parts)) {
    expectedParts[pid] = { s3Key: s3Key ?? `raw/u/up/${pid}`, contentSha256: null };
  }
  return { uploadId: 'up', source: 'claude', expectedParts, consumedAt: null, jobId: null };
}

/** presign 落 manifest（声明 expected parts，未兑换）。 */
async function seedManifest(db: ImportFakeDb, owner: string, uploadId: string): Promise<void> {
  await persistUploadManifest(db, {
    ownerUserId: owner,
    uploadId,
    source: 'claude',
    totalBytes: 10,
    expectedParts: [
      { clientPartId: 'p0', s3Key: `raw/${owner}/${uploadId}/p0`, contentSha256: null },
    ],
  });
}

describe('evaluateManifestGate（直传完整性闸判齐）', () => {
  it('全部 expected part 到齐 → complete=true + 有序 rawS3Keys（按 clientPartId 字典序）', () => {
    const m = manifest({ p0: 'k0', p2: 'k2', p1: 'k1' });
    const g = evaluateManifestGate(m, ['k1', 'k0', 'k2']);
    expect(g.complete).toBe(true);
    expect(g.expectedCount).toBe(3);
    expect(g.landedCount).toBe(3);
    expect(g.rawS3Keys).toEqual(['k0', 'k1', 'k2']); // p0/p1/p2 字典序
  });

  it('N 分片只到 1 片 → complete=false（manifest 闸拦住，绝不放行建 job）', () => {
    const m = manifest({ p0: 'k0', p1: 'k1', p2: 'k2' });
    const g = evaluateManifestGate(m, ['k0']);
    expect(g.complete).toBe(false);
    expect(g.expectedCount).toBe(3);
    expect(g.landedCount).toBe(1);
  });

  it('expected 为空（无声明）→ complete=false（空 manifest 不误放行）', () => {
    const g = evaluateManifestGate(manifest({}), ['k0']);
    expect(g.complete).toBe(false);
  });

  it('桶里有额外对象但 expected 未齐 → 仍 false（只认 manifest 声明的 expected key）', () => {
    const m = manifest({ p0: 'k0', p1: 'k1' });
    const g = evaluateManifestGate(m, ['k0', 'k-stray', 'k-other']); // 多了无关对象、缺 k1
    expect(g.complete).toBe(false);
    expect(g.landedCount).toBe(1);
  });
});

describe('upload-manifest-repo persist/read（ImportFakeDb）', () => {
  it('persist → read 回放 expected parts + consumed_at/job_id 初始为空', async () => {
    const db = new ImportFakeDb();
    await persistUploadManifest(db, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      source: 'claude',
      totalBytes: 30,
      expectedParts: [
        { clientPartId: 'p0', s3Key: 'raw/u1/up1/p0', contentSha256: 'h0' },
        { clientPartId: 'p1', s3Key: 'raw/u1/up1/p1', contentSha256: null },
      ],
    });
    const m = await readUploadManifest(db, 'u1', 'up1');
    expect(m).not.toBeNull();
    expect(Object.keys(m!.expectedParts)).toEqual(['p0', 'p1']);
    expect(m!.expectedParts.p0!.contentSha256).toBe('h0');
    expect(m!.consumedAt).toBeNull();
    expect(m!.jobId).toBeNull();
  });

  it('跨 owner 读不到（owner 守门）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    expect(await readUploadManifest(db, 'attacker', 'up1')).toBeNull();
  });
});

describe('consumeManifestAndInsertJob 原子兑换 + 建 job + 回写 job_id（Codex P1-r5）', () => {
  it('首次 → 兑换成功 + 建 job + 回写 job_id（不变式 consumed_at 非空 ⇒ job_id 非空）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const out = await consumeManifestAndInsertJob(db, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      rawS3Keys: ['k0'],
      source: 'claude',
      initialProgressJson: JSON.stringify(initialImportProgress()),
    });
    expect(out).not.toBeNull();
    expect(out!.fenceToken).toBe(1); // >0 表「需入队」
    expect(db.jobs.size).toBe(1);
    const upl = db.uploads.get('u1:up1')!;
    expect(upl.consumed_at).not.toBeNull(); // 已兑换
    expect(upl.job_id).toBe(out!.jobId); // 同语句回写 job_id（不变式）
  });

  it('二次（已兑换）→ 0 行：不重复建 job（恢复回放的第二道闸）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const initialProgressJson = JSON.stringify(initialImportProgress());
    const first = await consumeManifestAndInsertJob(db, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      rawS3Keys: ['k0'],
      source: 'claude',
      initialProgressJson,
    });
    expect(first).not.toBeNull();
    const second = await consumeManifestAndInsertJob(db, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      rawS3Keys: ['k0'],
      source: 'claude',
      initialProgressJson,
    });
    expect(second).toBeNull(); // 已兑换 → 不重复建
    expect(db.jobs.size).toBe(1); // 仍只 1 个 job
  });

  it('【单次 UPDATE 不变式 Codex P1-r6】成功兑换后绝不出现 consumed_at 非空 ∧ job_id IS NULL（两列同写落回）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const out = await consumeManifestAndInsertJob(db, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      rawS3Keys: ['k0'],
      source: 'claude',
      initialProgressJson: JSON.stringify(initialImportProgress()),
    });
    expect(out).not.toBeNull();
    const upl = db.uploads.get('u1:up1')!;
    // 关键不变式：单次 UPDATE 把 consumed_at/job_id 一并落 → 绝不出现「已消费但 job_id 为空」。
    expect(upl.consumed_at).not.toBeNull();
    expect(upl.job_id).not.toBeNull();
    expect(upl.job_id).toBe(out!.jobId);
    expect(upl.consumed_at !== null && upl.job_id === null).toBe(false);
    // job_id 真能恢复出建出的 job（同 uploadId 重试据此回放 JobView，非 404）。
    expect(db.jobs.has(upl.job_id!)).toBe(true);
  });

  it('【忠实 mock 自证 Codex P1-r6】旧 buggy SQL（consumed UPDATE 置 consumed_at + linked 二次 UPDATE 同行回写 job_id）→ 真实 PG 二次改不可靠 → 留下 consumed_at 非空 但 job_id IS NULL', async () => {
    // 直接喂忠实 mock 一条「旧两次 UPDATE 同一行」形态的 data-modifying CTE（Codex r5 命中形态）：
    //   consumed = UPDATE import_uploads 先置 consumed_at（第一次改该行）。
    //   linked   = UPDATE import_uploads SET job_id=new_job.id（**第二次**改同一行）。
    //   忠实真实 PG：单语句二次改同一行不可靠 → mock 模拟 job_id 不落回 → 不变式破坏：consumed_at 非空 但 job_id 仍 null。
    //   这证明 mock 已忠实建模该 PG 语义；新实现（active 守门 + 单次 UPDATE）则绝不会留下此破坏（见上一条回归）。
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const buggyTwoUpdateSql = `WITH consumed AS (
        UPDATE import_uploads
           SET consumed_at = now(), updated_at = now()
         WHERE owner_user_id = $1 AND upload_id = $2 AND consumed_at IS NULL
        RETURNING id, owner_user_id
     ),
     new_job AS (
        INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
        SELECT 'import', 'queued', c.owner_user_id, $3::jsonb, $4::jsonb, 1
          FROM consumed c
        RETURNING id, fence_token, attempt_no, created_at
     ),
     linked AS (
        UPDATE import_uploads u
           SET job_id = (SELECT id FROM new_job), updated_at = now()
         WHERE u.id = (SELECT id FROM consumed)
         RETURNING u.id
     )
     SELECT id, fence_token, attempt_no, created_at FROM new_job`;
    await db.query(buggyTwoUpdateSql, [
      'u1',
      'up1',
      JSON.stringify({ rawS3Keys: ['k0'] }),
      JSON.stringify(initialImportProgress()),
    ]);
    const upl = db.uploads.get('u1:up1')!;
    // 忠实 PG：第一次 UPDATE 置了 consumed_at，但第二次 UPDATE（回写 job_id）不可靠 → job_id 仍 null。
    expect(upl.consumed_at).not.toBeNull();
    expect(upl.job_id).toBeNull(); // ⚠️ 不变式破坏：已消费却无 job_id（同 uploadId 重试无法按 job_id 恢复）。
    expect(db.jobs.size).toBe(1); // job 已建（但 manifest 回不出它 → 正是 Codex r5/r6 命中的 bug）。
  });

  it('原子：模拟 job INSERT 失败 → 整体回滚，consumed_at 未提交（manifest 仍可重试）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    db.failOn = 'INSERT INTO jobs'; // 注入：CTE 内 job INSERT 抛错 → 整条原子语句失败
    await expect(
      consumeManifestAndInsertJob(db, {
        ownerUserId: 'u1',
        uploadId: 'up1',
        rawS3Keys: ['k0'],
        source: 'claude',
        initialProgressJson: JSON.stringify(initialImportProgress()),
      }),
    ).rejects.toThrow();
    db.failOn = null;
    // 关键：consumed_at 未落（同事务原子：要么都成、要么都不成）→ 同 uploadId 仍可重试。
    const m = await readUploadManifest(db, 'u1', 'up1');
    expect(m!.consumedAt).toBeNull();
    expect(m!.jobId).toBeNull();
    expect(db.jobs.size).toBe(0); // 没建出孤儿 job
  });
});

describe('createImportJobFromManifest 入队失败留 queued + 同 uploadId 可恢复（Codex P1-r5）', () => {
  const txPool = (db: ImportFakeDb) =>
    db as unknown as Parameters<typeof createImportJobFromManifest>[0];

  it('enqueue 失败 → 不删/不标 failed：job 留 queued（created.enqueued=false），返回真实 JobView（非 503）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const queue = {
      enqueue: async () => {
        throw new Error('redis down');
      },
    };
    const result = await createImportJobFromManifest(txPool(db), db, queue, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      source: 'claude',
      rawS3Keys: ['k0'],
    });
    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      expect(result.enqueued).toBe(false); // 入队失败
      expect(result.view.status).toBe('queued'); // 真实 queued JobView（非 503、非假转圈）
      expect(result.view.progress.subtasks).toHaveLength(5); // 五项子任务 pending
    }
    // 关键：manifest+job 同事务已提交，job 留 queued（不删、不标 failed）。
    expect(db.jobs.size).toBe(1);
    const job = [...db.jobs.values()][0]!;
    expect(job.status).toBe('queued');
    const upl = db.uploads.get('u1:up1')!;
    expect(upl.consumed_at).not.toBeNull();
    expect(upl.job_id).toBe(job.id);
  });

  it('enqueue 失败后 → staleQueued sweeper 补投该 job 成功（不裸转圈）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const failQueue = {
      enqueue: async () => {
        throw new Error('redis down');
      },
    };
    const created = await createImportJobFromManifest(txPool(db), db, failQueue, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      source: 'claude',
      rawS3Keys: ['k0'],
    });
    expect(created.kind).toBe('created');
    const jobId = created.kind === 'created' ? created.view.id : '';

    // sweeper 跑一轮：staleQueued 扫到停滞 queued、用既有 fence 补投。
    const reEnqueued: Array<{ type: string; jobId: string; fence: number }> = [];
    const reEnqueue = {
      enqueue: async (type: string, id: string, fence: number) => {
        reEnqueued.push({ type, jobId: id, fence });
      },
    };
    const typeLookup = {
      typeOf: async (id: string) => (db.jobs.get(id) ? ('import' as const) : undefined),
    };
    const res = await reconcileJobsOnce(db, reEnqueue, typeLookup, 50, 0);
    expect(res.requeuedQueued).toBe(1); // 补投了 1 条停滞 queued
    expect(reEnqueued).toEqual([{ type: 'import', jobId, fence: 1 }]); // 用既有 fence(=1) 补投
  });

  it('同一 uploadId enqueue 失败后重试 → 恢复同一 job 的 JobView（非 404、非新建）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const failQueue = {
      enqueue: async () => {
        throw new Error('redis down');
      },
    };
    const first = await createImportJobFromManifest(txPool(db), db, failQueue, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      source: 'claude',
      rawS3Keys: ['k0'],
    });
    expect(first.kind).toBe('created');
    const firstJobId = first.kind === 'created' ? first.view.id : '';

    // 重试（manifest 已 consumed、job_id 已回写）→ 恢复同一 job，不重复建。
    const okQueue = { enqueue: async () => {} };
    const retry = await createImportJobFromManifest(txPool(db), db, okQueue, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      source: 'claude',
      rawS3Keys: ['k0'],
    });
    expect(retry.kind).toBe('recovered'); // 非 404、非新建
    if (retry.kind === 'recovered') {
      expect(retry.view.id).toBe(firstJobId); // 同一个 job
      expect(retry.view.status).toBe('queued');
    }
    expect(db.jobs.size).toBe(1); // 没重复建 job
  });

  it('readJobViewForRecovery：owner 守门（非本人 job 恢复读不到）', async () => {
    const db = new ImportFakeDb();
    await seedManifest(db, 'u1', 'up1');
    const created = await consumeManifestAndInsertJob(db, {
      ownerUserId: 'u1',
      uploadId: 'up1',
      rawS3Keys: ['k0'],
      source: 'claude',
      initialProgressJson: JSON.stringify(initialImportProgress()),
    });
    expect(await readJobViewForRecovery(db, 'u1', created!.jobId)).not.toBeNull();
    expect(await readJobViewForRecovery(db, 'attacker', created!.jobId)).toBeNull();
  });
});
