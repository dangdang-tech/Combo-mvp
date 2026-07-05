// 产物工具 upsert：MinIO 键稳定（更新即覆写同一对象）/ 表行原地更新 / 幻觉 id 按新建处理。
import { describe, expect, it } from 'vitest';
import type { ArtifactView } from '@cb/shared';
import { createArtifactTool } from '../modules/artifact/tool.js';
import { ARTIFACT_BUCKET, artifactStorageKey } from '../modules/artifact/repo.js';
import { FakeDb, FakeObjectStore } from './fakes.js';

const SESSION = 'sess-000001';

function setup() {
  const db = new FakeDb();
  const store = new FakeObjectStore();
  const emitted: ArtifactView[] = [];
  const tool = createArtifactTool({
    db,
    objectStore: store,
    sessionId: SESSION,
    onArtifact: (a) => emitted.push(a),
  });
  return { db, store, emitted, tool };
}

describe('upsert_artifact 工具', () => {
  it('新建：写 MinIO + 插表行 + 回调产物视图，回执带 artifactId', async () => {
    const { db, store, emitted, tool } = setup();
    const result = await tool.execute('tc-1', {
      kind: 'html',
      title: '周报页面',
      content: '<!doctype html><html>v1</html>',
    });

    const id = result.details!.artifactId;
    expect(id).toBeTruthy();
    // MinIO 键按 (session, artifact) 稳定。
    const key = artifactStorageKey(SESSION, id);
    expect(await store.getObjectText(ARTIFACT_BUCKET as never, key)).toContain('v1');
    // 表行。
    const row = db.artifacts.get(id);
    expect(row?.kind).toBe('html');
    expect(row?.title).toBe('周报页面');
    expect(row?.storage_key).toBe(key);
    // 产物更新回调（run-turn 据此发 AG-UI 事件）。
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.id).toBe(id);
  });

  it('更新：同 artifactId → 同一 MinIO 键覆写内容，表行原地更新（无新行）', async () => {
    const { db, store, tool } = setup();
    const first = await tool.execute('tc-1', {
      kind: 'html',
      title: '周报页面',
      content: '<!doctype html><html>v1</html>',
    });
    const id = first.details!.artifactId;

    const second = await tool.execute('tc-2', {
      artifactId: id,
      kind: 'html',
      title: '周报页面（改）',
      content: '<!doctype html><html>v2</html>',
    });
    expect(second.details!.artifactId).toBe(id); // id 稳定
    expect(db.artifacts.size).toBe(1); // 无版本、无新行
    expect(db.artifacts.get(id)?.title).toBe('周报页面（改）');

    const key = artifactStorageKey(SESSION, id);
    expect(await store.getObjectText(ARTIFACT_BUCKET as never, key)).toContain('v2'); // 原地覆盖
  });

  it('幻觉/跨会话 artifactId → 按新建处理（不覆盖别人的对象）', async () => {
    const { db, tool } = setup();
    const result = await tool.execute('tc-1', {
      artifactId: 'made-up-id',
      kind: 'markdown',
      title: '笔记',
      content: '# hi',
    });
    expect(result.details!.artifactId).not.toBe('made-up-id');
    expect(db.artifacts.has('made-up-id')).toBe(false);
    expect(db.artifacts.size).toBe(1);
  });
});
