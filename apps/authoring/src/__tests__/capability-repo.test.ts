// 能力项仓储自检：发布标记 owner 守卫、share_token 生成与保留。忠实假 PG。
import { describe, it, expect } from 'vitest';
import {
  insertCapability,
  publishCapability,
  unpublishCapability,
} from '../modules/capability/repo.js';
import { FakeDb, nextId } from './fakes.js';

const OWNER = 'user-me';
const OTHER = 'user-other';

async function seedCapability(db: FakeDb): Promise<string> {
  const id = nextId('cap');
  await insertCapability(db, {
    id,
    taskId: 'task-x',
    ownerUserId: OWNER,
    name: '周报整理',
    summary: '把散乱记录整理成结构化周报',
    kind: '写作',
    storageKey: `capabilities/${id}/definition.json`,
    meta: {},
  });
  return id;
}

describe('publish / unpublish', () => {
  it('发布：标记置真、记时间、生成分享令牌；返回视图', async () => {
    const db = new FakeDb();
    const id = await seedCapability(db);
    const view = await publishCapability(db, {
      capabilityId: id,
      ownerUserId: OWNER,
      shareToken: 'tok-1',
    });
    expect(view).toMatchObject({ id, published: true, shareToken: 'tok-1' });
    expect(view!.publishedAt).toBeTruthy();
  });

  it('取消发布再发布：share_token 保留首次的（分享链接不因反复上下架失效）', async () => {
    const db = new FakeDb();
    const id = await seedCapability(db);
    await publishCapability(db, { capabilityId: id, ownerUserId: OWNER, shareToken: 'tok-first' });
    const off = await unpublishCapability(db, { capabilityId: id, ownerUserId: OWNER });
    expect(off).toMatchObject({ published: false });
    expect(db.capabilities.get(id)!.share_token).toBe('tok-first');
    const on = await publishCapability(db, {
      capabilityId: id,
      ownerUserId: OWNER,
      shareToken: 'tok-second',
    });
    expect(on!.shareToken).toBe('tok-first');
  });

  it('owner 守卫：非本人发布/下架 → null（0 行不命中）', async () => {
    const db = new FakeDb();
    const id = await seedCapability(db);
    expect(
      await publishCapability(db, { capabilityId: id, ownerUserId: OTHER, shareToken: 't' }),
    ).toBeNull();
    expect(await unpublishCapability(db, { capabilityId: id, ownerUserId: OTHER })).toBeNull();
    expect(db.capabilities.get(id)!.published).toBe(false);
  });
});
