// B-19 快照/段落仓储自检：受保护 fence CTE 写入（建快照/写段去重/fence-out）、血缘归并、只读 owner 守门 + 分页。
import { describe, it, expect } from 'vitest';
import type { RedactionReportView } from '@cb/shared';
import {
  insertSnapshotProtected,
  insertSegmentProtected,
  supersedePriorSnapshots,
  markRawPurgedProtected,
  getSnapshotForOwner,
  listSnapshotSegments,
  listOwnerSnapshots,
} from '../import/snapshot-repo.js';
import { ImportFakeDb, type JobRowF } from './import-fakes.js';

const REPORT: RedactionReportView = {
  applied: true,
  totalRedactions: 2,
  byCategory: [{ category: 'phone', count: 2, label: '手机号' }],
  rulesetVersion: 'redaction-v1',
};

function runningJob(db: ImportFakeDb, id: string, owner: string, fence: number): JobRowF {
  const j: JobRowF = {
    id,
    type: 'import',
    status: 'running',
    owner_user_id: owner,
    subject_ref: null,
    progress: {},
    fence_token: fence,
  };
  db.jobs.set(id, j);
  return j;
}

function snapArgs(
  jobId: string,
  fence: number,
  over: Partial<Parameters<typeof insertSnapshotProtected>[1]> = {},
) {
  return {
    jobId,
    fenceToken: fence,
    source: 'mixed' as const,
    sources: ['claude', 'codex'] as const,
    rawS3Key: 'raw/k0',
    segmentCount: 3,
    messageCount: 30,
    projectCount: 2,
    timeFrom: '2026-03-01',
    timeTo: '2026-06-01',
    redactionReport: REPORT,
    rulesetVersion: 'redaction-v1',
    ...over,
  };
}

describe('insertSnapshotProtected (fence CTE 模板②)', () => {
  it('fence + running 命中 → 建快照、owner/job 取自 jobs 行（血缘焊死）', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 5);
    const id = await insertSnapshotProtected(db, snapArgs('j1', 5));
    expect(id).toBeTruthy();
    const snap = db.snapshots.get(id!)!;
    expect(snap.owner_user_id).toBe('u1'); // 取自 jobs.owner，不靠入参
    expect(snap.import_job_id).toBe('j1');
    expect(snap.segment_count).toBe(3);
    expect(snap.redaction_ruleset_ver).toBe('redaction-v1');
  });

  it('fence 失配（取消/接管换 fence）→ 0 行 → null（不建快照，已生成不丢/安全退出）', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 9); // 当前 fence=9
    const id = await insertSnapshotProtected(db, snapArgs('j1', 5)); // 用旧 fence=5
    expect(id).toBeNull();
    expect(db.snapshots.size).toBe(0);
  });

  it('job 非 running（已取消）→ 0 行 → null', async () => {
    const db = new ImportFakeDb();
    const j = runningJob(db, 'j1', 'u1', 5);
    j.status = 'cancelled';
    const id = await insertSnapshotProtected(db, snapArgs('j1', 5));
    expect(id).toBeNull();
  });
});

describe('insertSegmentProtected (fence CTE 模板③ 联表 + 快照内去重)', () => {
  it('成功写段 → inserted + segmentId', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const snapId = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    const res = await insertSegmentProtected(db, {
      snapshotId: snapId,
      fenceToken: 1,
      contentHash: 'h1',
      source: 'claude',
      title: '标题',
      dateLabel: '03-20',
      happenedAt: '2026-03-20T00:00:00.000Z',
      project: 'proj',
      messageCount: 10,
      content: '去敏后正文',
    });
    expect(res.inserted).toBe(true);
    expect(res.segmentId).toBeTruthy();
    expect(db.segments.size).toBe(1);
  });

  it('同快照 content_hash 撞重 → DO NOTHING → inserted:false reason=duplicate（导入-22 照常完成不报错）', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const snapId = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    const base = {
      snapshotId: snapId,
      fenceToken: 1,
      contentHash: 'dup',
      source: 'claude' as const,
      title: 't',
      dateLabel: '',
      happenedAt: null,
      project: null,
      messageCount: 1,
      content: 'x',
    };
    const a = await insertSegmentProtected(db, base);
    const b = await insertSegmentProtected(db, base);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.reason).toBe('duplicate');
    expect(db.segments.size).toBe(1); // 去重：只一行
  });

  it('fence 失配 → 0 行 → inserted:false reason=fenced_out（被接管，已写段保留）', async () => {
    const db = new ImportFakeDb();
    const j = runningJob(db, 'j1', 'u1', 1);
    const snapId = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    // 模拟取消：换 fence
    j.fence_token = 2;
    const res = await insertSegmentProtected(db, {
      snapshotId: snapId,
      fenceToken: 1, // 旧 fence
      contentHash: 'h',
      source: 'claude',
      title: 't',
      dateLabel: '',
      happenedAt: null,
      project: null,
      messageCount: 1,
      content: 'x',
    });
    expect(res.inserted).toBe(false);
    expect(res.reason).toBe('fenced_out');
  });
});

describe('supersedePriorSnapshots (重导血缘 + fence/status 守门，导入-21 / Codex P1-r3)', () => {
  it('赢家 fence + running → 旧 latest 快照 superseded_by ← 新快照（旧保留、isLatest=false）', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const old = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    runningJob(db, 'j2', 'u1', 1);
    const fresh = (await insertSnapshotProtected(db, snapArgs('j2', 1)))!;
    const n = await supersedePriorSnapshots(db, fresh, 'u1', 'j2', 1);
    expect(n).toBe(1);
    expect(db.snapshots.get(old)!.superseded_by).toBe(fresh); // 旧被接替
    expect(db.snapshots.get(fresh)!.superseded_by).toBeNull(); // 新仍 latest
  });

  it('只影响本 owner（别人快照不串）', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'jA', 'uA', 1);
    const a = (await insertSnapshotProtected(db, snapArgs('jA', 1)))!;
    runningJob(db, 'jB', 'uB', 1);
    const b = (await insertSnapshotProtected(db, snapArgs('jB', 1)))!;
    await supersedePriorSnapshots(db, a, 'uA', 'jA', 1);
    expect(db.snapshots.get(b)!.superseded_by).toBeNull(); // 别人快照未受影响
  });

  it('fence-out（接管换 fence）→ guard 0 行 → 旧快照 superseded_by 不变（取消不污染血缘，Codex P1-r3）', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const old = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    const j2 = runningJob(db, 'j2', 'u1', 1);
    const fresh = (await insertSnapshotProtected(db, snapArgs('j2', 1)))!;
    // 收尾前 job 被接管换了 fence（fence-out）：supersede 用旧 fence=1，但 job 现 fence=2。
    j2.fence_token = 2;
    const n = await supersedePriorSnapshots(db, fresh, 'u1', 'j2', 1);
    expect(n).toBe(0); // guard 不命中 → 不动血缘
    expect(db.snapshots.get(old)!.superseded_by).toBeNull(); // 旧快照血缘未变（取消不丢、不串）
  });

  it('job 非 running（取消/已离开 running）→ guard 0 行 → 旧快照 superseded_by 不变', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const old = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    const j2 = runningJob(db, 'j2', 'u1', 1);
    const fresh = (await insertSnapshotProtected(db, snapArgs('j2', 1)))!;
    j2.status = 'cancelled'; // 取消：job 离开 running。
    const n = await supersedePriorSnapshots(db, fresh, 'u1', 'j2', 1);
    expect(n).toBe(0);
    expect(db.snapshots.get(old)!.superseded_by).toBeNull(); // 取消路径绝不更新血缘
  });
});

describe('markRawPurgedProtected (原文清弃，导入-33)', () => {
  it('fence 命中 → 标 raw_purged_at；fence 失配 → 不标', async () => {
    const db = new ImportFakeDb();
    const j = runningJob(db, 'j1', 'u1', 1);
    const snapId = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    expect(await markRawPurgedProtected(db, snapId, 1)).toBe(true);
    expect(db.snapshots.get(snapId)!.raw_purged_at).not.toBeNull();
    // 换 fence 后再标 → 0 行
    j.fence_token = 2;
    db.snapshots.get(snapId)!.raw_purged_at = null;
    expect(await markRawPurgedProtected(db, snapId, 1)).toBe(false);
  });
});

describe('只读查询 owner 守门 + 分页', () => {
  it('getSnapshotForOwner：属主拿到 SnapshotView；非属主 → null（404 不暴露存在性）', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const snapId = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    const mine = await getSnapshotForOwner(db, snapId, 'u1');
    expect(mine?.stats.segmentCount).toBe(3);
    expect(mine?.redaction.applied).toBe(true);
    expect(mine?.stats.timeSpan).toEqual({ from: '2026-03-01', to: '2026-06-01' });
    const notMine = await getSnapshotForOwner(db, snapId, 'attacker');
    expect(notMine).toBeNull();
  });

  it('listSnapshotSegments：节选只读、cursor 分页、非属主 → ownsSnapshot=false', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const snapId = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    for (let i = 0; i < 3; i++) {
      await insertSegmentProtected(db, {
        snapshotId: snapId,
        fenceToken: 1,
        contentHash: `h${i}`,
        source: 'claude',
        title: `t${i}`,
        dateLabel: '03-20',
        happenedAt: null,
        project: null,
        messageCount: 1,
        content: `c${i}`,
      });
    }
    const page1 = await listSnapshotSegments(db, {
      snapshotId: snapId,
      ownerUserId: 'u1',
      limit: 2,
    });
    expect(page1.ownsSnapshot).toBe(true);
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]!.readOnly).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listSnapshotSegments(db, {
      snapshotId: snapId,
      ownerUserId: 'u1',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    // 非属主
    const attacker = await listSnapshotSegments(db, { snapshotId: snapId, ownerUserId: 'x' });
    expect(attacker.ownsSnapshot).toBe(false);
  });

  it('listOwnerSnapshots：重导后旧快照仍在列表、isLatest 标记正确', async () => {
    const db = new ImportFakeDb();
    runningJob(db, 'j1', 'u1', 1);
    const old = (await insertSnapshotProtected(db, snapArgs('j1', 1)))!;
    runningJob(db, 'j2', 'u1', 1);
    const fresh = (await insertSnapshotProtected(db, snapArgs('j2', 1)))!;
    await supersedePriorSnapshots(db, fresh, 'u1', 'j2', 1);
    const list = await listOwnerSnapshots(db, { ownerUserId: 'u1', limit: 50 });
    expect(list.items).toHaveLength(2); // 旧快照不删、仍可查
    const oldItem = list.items.find((s) => s.id === old)!;
    const freshItem = list.items.find((s) => s.id === fresh)!;
    expect(oldItem.isLatest).toBe(false);
    expect(oldItem.supersededBySnapshotId).toBe(fresh);
    expect(freshItem.isLatest).toBe(true);
  });
});
