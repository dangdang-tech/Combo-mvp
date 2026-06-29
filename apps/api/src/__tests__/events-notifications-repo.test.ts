// B-35 · /notifications 仓储单测（70 §5.4）：列表 cursor 分页 / 标已读幂等 / 全部已读 / 未读数 / 越权 404。
import { describe, it, expect, vi } from 'vitest';
import {
  listNotifications,
  markRead,
  markAllRead,
  unreadCount,
} from '../events/notifications-repo.js';
import type { QueryableDb } from '../events/db-tx.js';

function scriptedDb(
  handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number },
): {
  db: QueryableDb;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: QueryableDb = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return handler(sql, params) as never;
    }),
  };
  return { db, calls };
}

function row(id: string, readAt: string | null = null): Record<string, unknown> {
  return {
    id,
    kind: 'import_completed',
    title: '导入完成',
    body: '已整理',
    link: '/x',
    read_at: readAt,
    created_at: '2026-06-16T00:00:00.000Z',
  };
}

describe('listNotifications (cursor 分页，本人 recipient)', () => {
  it('多取一条判 hasMore → 返回 limit 条 + nextCursor=末条 id', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [row('a'), row('b'), row('c')] })); // limit=2 → 取 3
    const r = await listNotifications(db, { recipientId: 'u1', limit: 2 });
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(r.nextCursor).toBe('b');
    expect(calls[0]!.sql).toContain('recipient_id = $1');
    expect(calls[0]!.params?.[0]).toBe('u1');
  });

  it('不足一页 → nextCursor=null', async () => {
    const { db } = scriptedDb(() => ({ rows: [row('a')] }));
    const r = await listNotifications(db, { recipientId: 'u1', limit: 20 });
    expect(r.nextCursor).toBeNull();
    expect(r.items).toHaveLength(1);
  });

  it('filter=unread → SQL 含 read_at IS NULL', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [] }));
    await listNotifications(db, { recipientId: 'u1', filter: 'unread' });
    expect(calls[0]!.sql).toContain('read_at IS NULL');
  });

  it('cursor + desc → SQL 含 id < $cursor', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [] }));
    await listNotifications(db, { recipientId: 'u1', cursor: 'mid', order: 'desc' });
    expect(calls[0]!.sql).toContain('id <');
    expect(calls[0]!.params).toContain('mid');
  });

  it('rowToView：body/link 为 null 时不带该字段，readAt 透传', async () => {
    const { db } = scriptedDb(() => ({
      rows: [{ ...row('a'), body: null, link: null, read_at: '2026-06-16T01:00:00.000Z' }],
    }));
    const r = await listNotifications(db, { recipientId: 'u1' });
    expect(r.items[0]).not.toHaveProperty('body');
    expect(r.items[0]).not.toHaveProperty('link');
    expect(r.items[0]!.readAt).toBe('2026-06-16T01:00:00.000Z');
  });
});

describe('markRead (幂等 + 越权 404)', () => {
  it('本人通知 → COALESCE(read_at, now()) 标已读，返回 view', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [row('a', '2026-06-16T02:00:00.000Z')] }));
    const view = await markRead(db, 'u1', 'a');
    expect(view?.id).toBe('a');
    expect(calls[0]!.sql).toContain('COALESCE(read_at, now())');
    expect(calls[0]!.sql).toContain('recipient_id = $2'); // owner 守门
    expect(calls[0]!.params).toEqual(['a', 'u1']);
  });

  it('非本人/不存在（0 行）→ 返回 null（调用方转 404，不暴露存在性）', async () => {
    const { db } = scriptedDb(() => ({ rows: [] }));
    const view = await markRead(db, 'u1', 'someone-else');
    expect(view).toBeNull();
  });
});

describe('markAllRead / unreadCount', () => {
  it('markAllRead → 返回本次置已读条数（rowCount）', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [], rowCount: 4 }));
    const updated = await markAllRead(db, 'u1');
    expect(updated).toBe(4);
    expect(calls[0]!.sql).toContain('read_at IS NULL'); // 只动未读，幂等第二次 0
  });

  it('markAllRead 第二次（无未读）→ updated:0', async () => {
    const { db } = scriptedDb(() => ({ rows: [], rowCount: 0 }));
    expect(await markAllRead(db, 'u1')).toBe(0);
  });

  it('unreadCount → count(read_at IS NULL)', async () => {
    const { db, calls } = scriptedDb(() => ({ rows: [{ unread: 7 }] }));
    expect(await unreadCount(db, 'u1')).toBe(7);
    expect(calls[0]!.sql).toContain('read_at IS NULL');
  });
});
