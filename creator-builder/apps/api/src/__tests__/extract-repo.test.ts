// B-22/B-23 提取仓储自检（extract-repo.ts，受保护写入 §11.A + 复合 FK §11.E）：
//   fence 守门（失配 → 0 行干净退出）、(extract_job_id,slug) 去重、(candidate_id,segment_id) 证据去重、
//   复合 FK 同快照（反向破坏：跨快照证据被 DB 拒）、segment_count 回填、retry 受保护写入。
import { describe, it, expect } from 'vitest';
import {
  readSnapshotSegments,
  insertCandidateProtected,
  insertEvidenceProtected,
  updateCandidateSegmentCountProtected,
  insertFailedCandidateProtected,
  readCandidateForOwner,
  applyRetrySuccessInTx,
  applyRetryFailureProtected,
  insertReadyCandidateWithEvidenceInTx,
  CandidateLandingFencedOut,
} from '../extract/extract-repo.js';
import { ExtractFakeDb, type JobRowF, type SegmentRowF } from './extract-fakes.js';

function runningJob(db: ExtractFakeDb, id = 'ejob-1', fence = 7, owner = 'u1'): JobRowF {
  const row: JobRowF = {
    id,
    type: 'extract',
    status: 'running',
    owner_user_id: owner,
    subject_ref: {},
    progress: {},
    fence_token: fence,
  };
  db.jobs.set(id, row);
  return row;
}

function seg(db: ExtractFakeDb, id: string, snapshotId: string): SegmentRowF {
  const s: SegmentRowF = {
    id,
    snapshot_id: snapshotId,
    title: 't',
    source: 'claude',
    project: 'p',
    happened_at: null,
    content: 'c',
    message_count: 1,
  };
  db.segments.set(id, s);
  return s;
}

function candidateArgs(jobId: string, fence: number, snapshotId: string, slug: string) {
  return {
    jobId,
    fenceToken: fence,
    snapshotId,
    slug,
    status: 'ready' as const,
    name: 'n',
    intent: 'i',
    type: 'recurring',
    confidence: 'med',
    segmentCount: 1,
    frequencyRatio: 0.5,
    reusability: 0.5,
    scopeCoherence: 0.5,
    splitSuggested: false,
    scope: { language: 'zh' },
    reusabilityBreakdown: { frequency: 0.5 },
    error: null,
  };
}

describe('readSnapshotSegments', () => {
  it('只读该 snapshot 段，按 id ASC（提取-30 稳定序）', async () => {
    const db = new ExtractFakeDb();
    seg(db, 's2', 'snap-1');
    seg(db, 's1', 'snap-1');
    seg(db, 'x1', 'snap-2');
    const rows = await readSnapshotSegments(db, 'snap-1');
    expect(rows.map((r) => r.segmentId)).toEqual(['s1', 's2']);
  });
});

describe('insertCandidateProtected — fence 守门 + (job,slug) 去重', () => {
  it('fence 匹配 + running → 建候选；owner 取自 jobs 行（不靠入参）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7, 'u1');
    const id = await insertCandidateProtected(db, candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'));
    expect(id).toBeTruthy();
    expect(db.candidates.get(id!)!.owner_user_id).toBe('u1');
  });

  it('fence 失配（被接管/取消换 fence）→ 0 行 → null（干净退出，不报错）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    const id = await insertCandidateProtected(db, candidateArgs('ejob-1', 999, 'snap-1', 'cap-a'));
    expect(id).toBeNull();
    expect(db.candidates.size).toBe(0);
  });

  it('非 running（已 completed/cancelled）→ 0 行 → null', async () => {
    const db = new ExtractFakeDb();
    const j = runningJob(db, 'ejob-1', 7);
    j.status = 'cancelled';
    const id = await insertCandidateProtected(db, candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'));
    expect(id).toBeNull();
  });

  it('(extract_job_id, slug) 撞重 → ON CONFLICT DO NOTHING → null（计数不翻倍，提取-32）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    const a = await insertCandidateProtected(db, candidateArgs('ejob-1', 7, 'snap-1', 'dup'));
    const b = await insertCandidateProtected(db, candidateArgs('ejob-1', 7, 'snap-1', 'dup'));
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    expect(db.candidates.size).toBe(1);
  });
});

describe('insertEvidenceProtected — 复合 FK 血缘（§11.E）', () => {
  it('候选 + 段 + 快照同源 → 写证据成功', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    seg(db, 'seg-1', 'snap-1');
    const cid = (await insertCandidateProtected(
      db,
      candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
    ))!;
    const ok = await insertEvidenceProtected(db, {
      jobId: 'ejob-1',
      fenceToken: 7,
      candidateId: cid,
      segmentId: 'seg-1',
      snapshotId: 'snap-1',
    });
    expect(ok).toBe(true);
    expect(db.evidence.size).toBe(1);
    expect([...db.evidence.values()][0]!.snapshot_id).toBe('snap-1');
  });

  it('反向破坏：证据 snapshot 与候选 snapshot 不同源 → DB 复合 FK 拒（fk_evidence_candidate_snapshot）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    seg(db, 'seg-1', 'snap-2'); // 段属 snap-2
    const cid = (await insertCandidateProtected(
      db,
      candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
    ))!; // 候选属 snap-1
    // 伪填 snapshotId=snap-1（与段的 snap-2 不符）→ fk_evidence_segment_snapshot 违反。
    await expect(
      insertEvidenceProtected(db, {
        jobId: 'ejob-1',
        fenceToken: 7,
        candidateId: cid,
        segmentId: 'seg-1',
        snapshotId: 'snap-1',
      }),
    ).rejects.toThrow(/fk_evidence_segment_snapshot|mismatch/);
    expect(db.evidence.size).toBe(0); // 跨快照证据被拒，绝不落库
  });

  it('反向破坏：伪填段的真 snapshot 但候选属别的快照 → fk_evidence_candidate_snapshot 违反', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    seg(db, 'seg-1', 'snap-2');
    const cid = (await insertCandidateProtected(
      db,
      candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
    ))!;
    await expect(
      insertEvidenceProtected(db, {
        jobId: 'ejob-1',
        fenceToken: 7,
        candidateId: cid,
        segmentId: 'seg-1',
        snapshotId: 'snap-2', // 与候选 snap-1 不符
      }),
    ).rejects.toThrow(/fk_evidence_candidate_snapshot|mismatch/);
  });

  it('fence 失配 → 证据 0 行（不写、不报错）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    seg(db, 'seg-1', 'snap-1');
    const cid = (await insertCandidateProtected(
      db,
      candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
    ))!;
    const ok = await insertEvidenceProtected(db, {
      jobId: 'ejob-1',
      fenceToken: 999,
      candidateId: cid,
      segmentId: 'seg-1',
      snapshotId: 'snap-1',
    });
    expect(ok).toBe(false);
    expect(db.evidence.size).toBe(0);
  });

  it('(candidate_id, segment_id) 撞重 → 同段不重复挂（频次诚实，提取-32/34）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    seg(db, 'seg-1', 'snap-1');
    const cid = (await insertCandidateProtected(
      db,
      candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
    ))!;
    const a = await insertEvidenceProtected(db, {
      jobId: 'ejob-1',
      fenceToken: 7,
      candidateId: cid,
      segmentId: 'seg-1',
      snapshotId: 'snap-1',
    });
    const b = await insertEvidenceProtected(db, {
      jobId: 'ejob-1',
      fenceToken: 7,
      candidateId: cid,
      segmentId: 'seg-1',
      snapshotId: 'snap-1',
    });
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(db.evidence.size).toBe(1);
  });
});

describe('updateCandidateSegmentCountProtected', () => {
  it('fence 匹配 → 回填 segment_count；fence 失配 → 0 行不改', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    const cid = (await insertCandidateProtected(
      db,
      candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
    ))!;
    const ok = await updateCandidateSegmentCountProtected(db, {
      jobId: 'ejob-1',
      fenceToken: 7,
      candidateId: cid,
      segmentCount: 5,
    });
    expect(ok).toBe(true);
    expect(db.candidates.get(cid)!.segment_count).toBe(5);
    const bad = await updateCandidateSegmentCountProtected(db, {
      jobId: 'ejob-1',
      fenceToken: 999,
      candidateId: cid,
      segmentCount: 9,
    });
    expect(bad).toBe(false);
    expect(db.candidates.get(cid)!.segment_count).toBe(5); // 未被改
  });
});

describe('insertReadyCandidateWithEvidenceInTx — 单候选原子落库（候选+证据+count 同事务，Codex r2#1）', () => {
  function candPayload() {
    const a = candidateArgs('ejob-1', 7, 'snap-1', 'cap-a');
    // 去掉 helper 已固定的 jobId/fenceToken/snapshotId/status/error 字段，只留候选骨架。
    const { jobId: _j, fenceToken: _f, snapshotId: _s, status: _st, error: _e, ...rest } = a;
    return rest;
  }

  it('成功：建 ready 候选 + 逐段证据 + segment_count = 实际写入证据数（提取-34）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7, 'u1');
    seg(db, 'seg-1', 'snap-1');
    seg(db, 'seg-2', 'snap-1');
    const out = await insertReadyCandidateWithEvidenceInTx({
      tx: db,
      jobId: 'ejob-1',
      fenceToken: 7,
      snapshotId: 'snap-1',
      candidate: candPayload(),
      segmentIds: ['seg-1', 'seg-2'],
    });
    expect(out.kind).toBe('inserted');
    if (out.kind !== 'inserted') return;
    expect(out.written).toBe(2);
    const c = db.candidates.get(out.candidateId)!;
    expect(c.status).toBe('ready');
    expect(c.segment_count).toBe(2); // 回填 = 实际写入证据数
    expect(
      [...db.evidence.values()].filter((e) => e.candidate_id === out.candidateId),
    ).toHaveLength(2);
  });

  it('事务开头 guard fence 失配 → 抛 CandidateLandingFencedOut（候选/证据全不落，无半 ready）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7, 'u1');
    seg(db, 'seg-1', 'snap-1');
    await expect(
      insertReadyCandidateWithEvidenceInTx({
        tx: db,
        jobId: 'ejob-1',
        fenceToken: 999, // 失配 → guard 0 行 → 哨兵
        snapshotId: 'snap-1',
        candidate: candPayload(),
        segmentIds: ['seg-1'],
      }),
    ).rejects.toBeInstanceOf(CandidateLandingFencedOut);
    expect(db.candidates.size).toBe(0); // 候选 INSERT 从未发生（guard 在最前拦下）
    expect(db.evidence.size).toBe(0);
  });

  it('(job,slug) 去重命中（guard 已持锁，候选 INSERT 0 行只可能去重）→ skipped（不抛、不留证据）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7, 'u1');
    seg(db, 'seg-1', 'snap-1');
    // 先建同 slug 候选占位（撞重）。
    await insertCandidateProtected(db, candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'));
    const before = db.candidates.size;
    const out = await insertReadyCandidateWithEvidenceInTx({
      tx: db,
      jobId: 'ejob-1',
      fenceToken: 7,
      snapshotId: 'snap-1',
      candidate: candPayload(), // 同 slug 'cap-a'
      segmentIds: ['seg-1'],
    });
    expect(out.kind).toBe('skipped'); // guard 持锁 → 0 行只可能是去重，不抛
    expect(db.candidates.size).toBe(before); // 不翻倍
    expect(db.evidence.size).toBe(0); // 去重 → 不写证据
  });
});

describe('insertFailedCandidateProtected — 失败态候选（单候选不阻塞，提取-17）', () => {
  it('status=failed + 人话 error + 稀疏字段', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7);
    const id = await insertFailedCandidateProtected(db, {
      jobId: 'ejob-1',
      fenceToken: 7,
      snapshotId: 'snap-1',
      slug: 'failed-cap',
      name: '保单条款比对器',
      error: {
        userMessage: '这一项没能识别出来，可点重试。',
        action: 'retry',
        retriable: true,
        traceId: 't',
      },
    });
    const c = db.candidates.get(id!)!;
    expect(c.status).toBe('failed');
    expect(c.name).toBe('保单条款比对器');
    expect(c.type).toBeNull();
    expect(c.confidence).toBeNull();
    expect((c.error as { userMessage: string }).userMessage).toContain('没能识别');
  });
});

describe('retry 受保护写入（B-23，§5.2）', () => {
  it('readCandidateForOwner：本人 → 返回；非本人 → null（不暴露存在性）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7, 'u1');
    seg(db, 'seg-1', 'snap-1');
    const cid = (await insertCandidateProtected(db, {
      ...candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
      status: 'failed' as const,
    }))!;
    expect(await readCandidateForOwner(db, cid, 'u1')).toBeTruthy();
    expect(await readCandidateForOwner(db, cid, 'someone-else')).toBeNull();
  });

  it('applyRetrySuccessInTx：ready 回写 + 删旧证据 + 重写 + segment_count 一致（fence 取自 retry job）', async () => {
    const db = new ExtractFakeDb();
    // 原候选属 snap-1（建于原 job），retry job 新建。
    runningJob(db, 'ejob-1', 7, 'u1');
    seg(db, 'seg-1', 'snap-1');
    seg(db, 'seg-2', 'snap-1');
    const cid = (await insertCandidateProtected(db, {
      ...candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
      status: 'failed' as const,
    }))!;
    // retry job（新 fence）。
    runningJob(db, 'retry-1', 11, 'u1');
    const ok = await applyRetrySuccessInTx({
      tx: db,
      retryJobId: 'retry-1',
      fenceToken: 11,
      candidateId: cid,
      snapshotId: 'snap-1',
      segmentIds: ['seg-1', 'seg-2'],
      fields: {
        name: 'n2',
        intent: 'i2',
        type: 'recurring',
        confidence: 'high',
        frequencyRatio: 0.9,
        reusability: 0.8,
        scopeCoherence: 0.7,
        splitSuggested: false,
        scope: { language: 'zh' },
        reusabilityBreakdown: { frequency: 0.9 },
      },
    });
    expect(ok).toBe(true);
    const c = db.candidates.get(cid)!;
    expect(c.status).toBe('ready');
    expect(c.name).toBe('n2');
    expect(c.segment_count).toBe(2);
    const evRows = [...db.evidence.values()].filter((e) => e.candidate_id === cid);
    expect(evRows).toHaveLength(2);
    // worker 收尾不再 +1（Codex#3 双重加一）：受理 CTE 才 +1，本函数只翻状态，retry_cnt 维持入参值（此处 0）。
    expect(c.retry_cnt).toBe(0);
  });

  it('applyRetrySuccessInTx fence 失配（retry job 被接管换 fence）→ 事务开头 guard 0 行 → 抛 CandidateLandingFencedOut，候选/证据不动（Codex r2#1）', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7, 'u1');
    seg(db, 'seg-1', 'snap-1');
    const cid = (await insertCandidateProtected(db, {
      ...candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
      status: 'failed' as const,
    }))!;
    runningJob(db, 'retry-1', 11, 'u1');
    // fence 失配 → 事务开头 FOR UPDATE guard 0 行 → 抛哨兵（外层 withTransaction 据此 ROLLBACK，不留半残）。
    await expect(
      applyRetrySuccessInTx({
        tx: db,
        retryJobId: 'retry-1',
        fenceToken: 999, // 失配
        candidateId: cid,
        snapshotId: 'snap-1',
        segmentIds: ['seg-1'],
        fields: {
          name: 'x',
          intent: 'y',
          type: 'recurring',
          confidence: 'low',
          frequencyRatio: 0,
          reusability: 0,
          scopeCoherence: 0,
          splitSuggested: false,
          scope: {},
          reusabilityBreakdown: {},
        },
      }),
    ).rejects.toBeInstanceOf(CandidateLandingFencedOut);
    expect(db.candidates.get(cid)!.status).toBe('failed'); // 未被改（guard 在任何写入前就拦下）
    expect(db.evidence.size).toBe(0); // 证据不动
  });

  it('applyRetryFailureProtected：再失败回 failed + 人话 error + retry_cnt+1', async () => {
    const db = new ExtractFakeDb();
    runningJob(db, 'ejob-1', 7, 'u1');
    const cid = (await insertCandidateProtected(db, {
      ...candidateArgs('ejob-1', 7, 'snap-1', 'cap-a'),
      status: 'failed' as const,
    }))!;
    runningJob(db, 'retry-1', 11, 'u1');
    const ok = await applyRetryFailureProtected(db, {
      retryJobId: 'retry-1',
      fenceToken: 11,
      candidateId: cid,
      error: {
        userMessage: '这一项多次没能识别出来，可反馈给我们。',
        action: 'escalate',
        retriable: true,
        traceId: 't',
      },
    });
    expect(ok).toBe(true);
    const c = db.candidates.get(cid)!;
    expect(c.status).toBe('failed');
    expect((c.error as { action: string }).action).toBe('escalate');
    // worker 收尾不再 +1（Codex#3 双重加一）：受理 CTE 才 +1，本函数只翻状态，retry_cnt 维持入参值（此处 0）。
    expect(c.retry_cnt).toBe(0);
  });
});
