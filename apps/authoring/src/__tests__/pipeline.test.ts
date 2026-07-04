// 提取流水线自检：成功 / 降级兜底 / 失败 / 未认领四条路径。忠实假 PG + 假对象存储/LLM/事件流。
import { describe, it, expect } from 'vitest';
import { createTask, transition } from '../modules/task/service.js';
import { RAW_BUCKET, rawObjectKey } from '../modules/task/pairing.js';
import { CAPABILITY_BUCKET, runPipeline, type PipelineDeps } from '../modules/task/pipeline.js';
import { FakeDb, FakeLlm, FakeObjectStore, FakeStream, llmText } from './fakes.js';

const OWNER = 'user-me';

/** Claude 导出格式的最小 JSONL 夹具（顶层 message 对象 → 解析器认作一段会话）。 */
function claudeJsonl(lines: Array<{ role: string; text: string }>): string {
  return lines
    .map((l) =>
      JSON.stringify({
        message: { role: l.role, content: [{ type: 'text', text: l.text }] },
        timestamp: '2026-07-04T10:00:00Z',
      }),
    )
    .join('\n');
}

const LLM_CAPABILITIES = JSON.stringify([
  {
    name: '周报整理',
    summary: '把散乱记录整理成结构化周报',
    kind: '写作',
    instructions: '你是周报整理助手。第一步收集要点，第二步分组，第三步输出结构化周报。',
  },
]);

interface Setup {
  deps: PipelineDeps & { db: FakeDb; objectStore: FakeObjectStore; stream: FakeStream };
  taskId: string;
}

/** 造一个已收齐、停在 extract/running 的任务（raw.txt 已在桶里）。 */
async function setup(llm: FakeLlm, raw?: string): Promise<Setup> {
  const db = new FakeDb();
  const objectStore = new FakeObjectStore();
  const stream = new FakeStream();
  const out = await createTask(db, db, { ownerUserId: OWNER, idempotencyKey: 'idem-key-000001' });
  if (out.kind !== 'ok') throw new Error('seed failed');
  const taskId = out.taskId;

  const content =
    raw ??
    claudeJsonl([
      { role: 'user', text: '帮我把这周的工作记录整理成周报' },
      { role: 'assistant', text: '好的，先列出本周完成事项……' },
    ]);
  await objectStore.putObject(RAW_BUCKET, rawObjectKey(taskId), new TextEncoder().encode(content));
  const upload = db.uploads.get(taskId)!;
  upload.status = 'raw';
  upload.storage_key = rawObjectKey(taskId);
  upload.parts = { total: 1, landed: { '0': `uploads/${taskId}/part-0` } };
  await transition(db, taskId, { step: 'upload', status: 'running' }, { step: 'extract' });

  const deps: Setup['deps'] = {
    db,
    objectStore,
    stream,
    llm,
    audit: { record: async () => undefined },
    leaseOwner: 'worker-test#1',
    model: 'test-model',
  };
  return { deps, taskId };
}

import { parseCapabilityJson } from '../modules/task/extract.js';

describe('parseCapabilityJson · 真实模型输出形态', () => {
  const item = '{"name":"周报整理","summary":"s","kind":"写作","instructions":"步骤如下"}';

  it('markdown 围栏 + 前后说明文字（含方括号）都能解析', () => {
    const noisy =
      '好的，[分析] 归纳如下：\n\n```json\n[' + item + ']\n```\n\n以上 [1] 个能力供参考。';
    const parsed = parseCapabilityJson(noisy);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.name).toBe('周报整理');
  });

  it('字符串值内的方括号与转义引号不干扰配平', () => {
    const tricky =
      '[{"name":"排查[413]","summary":"含\\"引号\\"与]括号","kind":"编码","instructions":"i"}]';
    const parsed = parseCapabilityJson(tricky);
    expect(parsed).toHaveLength(1);
  });

  it('空数组返回 []（由批处理层判空走兜底）；无 JSON → null', () => {
    expect(parseCapabilityJson('[]')).toEqual([]);
    expect(parseCapabilityJson('没有可归纳的能力。')).toBeNull();
  });
});

describe('runPipeline · 成功路径', () => {
  it('LLM 归纳成功：能力项落库 + 定义进桶 + 原始件清除 + 任务终态 + done 帧', async () => {
    const { deps, taskId } = await setup(new FakeLlm(() => llmText(LLM_CAPABILITIES)));
    const outcome = await runPipeline(deps, taskId, 'trace-1');
    expect(outcome).toBe('succeeded');

    // 能力项：一行索引 + 桶里一份可运行定义。
    const caps = [...deps.db.capabilities.values()];
    expect(caps).toHaveLength(1);
    expect(caps[0]!.name).toBe('周报整理');
    const def = JSON.parse(
      await deps.objectStore.getObjectText(CAPABILITY_BUCKET, caps[0]!.storage_key),
    );
    expect(def.version).toBe(1);
    expect(def.instructions).toContain('周报整理助手');

    // 任务终态 + 上传合规态：原始件已删、打了清除戳。
    const task = deps.db.tasks.get(taskId)!;
    expect(task.status).toBe('succeeded');
    expect(task.retry_count).toBe(0);
    const upload = deps.db.uploads.get(taskId)!;
    expect(upload.status).toBe('processed');
    expect(upload.raw_purged_at).not.toBeNull();
    await expect(
      deps.objectStore.getObjectText(RAW_BUCKET, rawObjectKey(taskId)),
    ).rejects.toThrow();

    // 帧序：快照/进度若干 + item-appended + 最后一帧 done(succeeded)。
    const events = deps.stream.events(taskId);
    expect(events).toContain('item-appended');
    expect(events[events.length - 1]).toBe('done');
  });

  it('原始件清除失败：任务仍成功，但 raw_purged_at 留空（合规戳不说谎）', async () => {
    const { deps, taskId } = await setup(new FakeLlm(() => llmText(LLM_CAPABILITIES)));
    deps.objectStore.delete = async () => {
      throw new Error('minio down');
    };
    expect(await runPipeline(deps, taskId, 'trace-1')).toBe('succeeded');
    const upload = deps.db.uploads.get(taskId)!;
    expect(upload.status).toBe('processed');
    expect(upload.raw_purged_at).toBeNull();
  });
});

describe('runPipeline · 降级兜底', () => {
  it('LLM 全程降级：走确定性兜底，仍产出可试用的能力项并成功终态', async () => {
    const { deps, taskId } = await setup(new FakeLlm()); // 缺省脚本恒 degraded
    expect(await runPipeline(deps, taskId, 'trace-1')).toBe('succeeded');
    const caps = [...deps.db.capabilities.values()];
    expect(caps.length).toBeGreaterThan(0);
    expect(caps[0]!.meta).toMatchObject({ degraded: true });
  });
});

describe('runPipeline · 失败与竞态', () => {
  it('原始件缺失：failed 终态 + last_error 人话 + done 帧带错误信封', async () => {
    const { deps, taskId } = await setup(new FakeLlm(() => llmText(LLM_CAPABILITIES)));
    deps.db.uploads.get(taskId)!.storage_key = null;
    expect(await runPipeline(deps, taskId, 'trace-1')).toBe('failed');

    const task = deps.db.tasks.get(taskId)!;
    expect(task.status).toBe('failed');
    const err = task.last_error as { userMessage: string; traceId: string };
    expect(err.userMessage.length).toBeGreaterThan(0);
    expect(err.userMessage).not.toMatch(/[A-Z]{2,}_/); // 人话，不裸露内部 code
    expect(err.traceId).toBe('trace-1');

    const frames = deps.stream.frames.filter((f) => f.taskId === taskId);
    expect(frames[frames.length - 1]!.event).toBe('done');
    expect(frames[frames.length - 1]!.payload).toMatchObject({ status: 'failed' });
  });

  it('租约被占：not_claimed 静默跳过，不动任务、不发帧', async () => {
    const { deps, taskId } = await setup(new FakeLlm(() => llmText(LLM_CAPABILITIES)));
    const t = deps.db.tasks.get(taskId)!;
    t.lease_owner = 'other-worker#9';
    t.lease_expires_at = new Date(Date.now() + 60_000).toISOString();
    expect(await runPipeline(deps, taskId, 'trace-1')).toBe('not_claimed');
    expect(t.status).toBe('running');
    expect(deps.stream.frames).toHaveLength(0);
  });
});
