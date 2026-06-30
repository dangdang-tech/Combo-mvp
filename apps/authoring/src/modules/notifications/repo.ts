// B-35 · /notifications 读写仓储（70 §5.4）。只读/操作本人通知（recipient_id = ctx.userId）；
//   越权读他人 → 视作 NOT_FOUND（不暴露存在性，§5.4）。纯逻辑，注入 QueryableDb，便于 mock 单测。
import type { NotificationView } from '@cb/shared';
import type { QueryableDb } from '../../platform/events/db-tx.js';

/** 列表分页入参（cursor = 上一页末条 created_at|id 复合游标的不透明串；本期用 seq 化 id 游标）。 */
export interface ListNotificationsParams {
  recipientId: string;
  cursor?: string;
  limit?: number;
  filter?: 'unread' | 'all';
  order?: 'asc' | 'desc';
}

export interface ListNotificationsResult {
  items: NotificationView[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function rowToView(r: {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}): NotificationView {
  return {
    id: r.id,
    kind: r.kind as NotificationView['kind'],
    title: r.title,
    ...(r.body !== null ? { body: r.body } : {}),
    ...(r.link !== null ? { link: r.link } : {}),
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

/**
 * GET /notifications：本人通知 cursor 分页（不返 total，未读数走专用端点，§5.4）。
 *   cursor 用 id 作锚（UUID v7 时间有序，与 created_at 同序）；desc 默认。
 */
export async function listNotifications(
  db: QueryableDb,
  params: ListNotificationsParams,
): Promise<ListNotificationsResult> {
  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const order = params.order ?? 'desc';
  const unreadOnly = params.filter === 'unread';

  const conds = ['recipient_id = $1'];
  const args: unknown[] = [params.recipientId];
  if (unreadOnly) conds.push('read_at IS NULL');
  if (params.cursor) {
    args.push(params.cursor);
    conds.push(order === 'desc' ? `id < $${args.length}` : `id > $${args.length}`);
  }
  args.push(limit + 1); // 多取一条判 hasMore

  const res = await db.query<{
    id: string;
    kind: string;
    title: string;
    body: string | null;
    link: string | null;
    read_at: string | null;
    created_at: string;
  }>(
    `SELECT id, kind, title, body, link, read_at, created_at
     FROM notifications
     WHERE ${conds.join(' AND ')}
     ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'}
     LIMIT $${args.length}`,
    args,
  );

  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
  return { items: page.map(rowToView), nextCursor };
}

/**
 * POST /notifications/{id}/read：标本人某通知已读（幂等：已读再标回放当前态）。
 *   WHERE recipient_id 守门：非本人/不存在 → 0 行 → 返 null（调用方转 404，不暴露存在性）。
 */
export async function markRead(
  db: QueryableDb,
  recipientId: string,
  notificationId: string,
): Promise<NotificationView | null> {
  const res = await db.query<{
    id: string;
    kind: string;
    title: string;
    body: string | null;
    link: string | null;
    read_at: string | null;
    created_at: string;
  }>(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND recipient_id = $2
     RETURNING id, kind, title, body, link, read_at, created_at`,
    [notificationId, recipientId],
  );
  const row = res.rows[0];
  return row ? rowToView(row) : null;
}

/**
 * POST /notifications/read-all：本人全部未读标已读（幂等：第二次 updated:0）。
 *   返回本次实际置已读条数（仅 read_at IS NULL 的行被更新）。
 */
export async function markAllRead(db: QueryableDb, recipientId: string): Promise<number> {
  const res = await db.query(
    `UPDATE notifications
     SET read_at = now()
     WHERE recipient_id = $1 AND read_at IS NULL`,
    [recipientId],
  );
  return res.rowCount ?? 0;
}

/** GET /notifications/unread-count：本人未读数（轻量，read_at IS NULL）。 */
export async function unreadCount(db: QueryableDb, recipientId: string): Promise<number> {
  const res = await db.query<{ unread: string | number }>(
    `SELECT count(*) AS unread FROM notifications WHERE recipient_id = $1 AND read_at IS NULL`,
    [recipientId],
  );
  return Number(res.rows[0]?.unread ?? 0);
}
