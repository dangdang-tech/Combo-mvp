// B-35 · NotifyConsumer（消费 notify.*，70 §5）。关页也收得到 = 站内表 + 外部通道，不走 SSE。
//   每条 notify 事件在【同一事务 tx】内：
//     ① INSERT notifications（站内，dedupe_key = 源 event_id，uq_notif_dedupe 幂等）
//     ② INSERT notification_channels（inapp 落库即成功 + lark/email pending 待外发）
//   外发投递（飞书/邮件）由 notification_channels 行驱动，失败不回滚站内、不卡 cursor（§5.2）。
//   通知漏发不致命 → 走 notify 毒丸策略（重试 N 次进 dead_events + 跳过，由 consumer-core 处理）。
import {
  NotifyImportCompletedPayloadSchema,
  NotifyExtractCompletedPayloadSchema,
  NotifyPublishCompletedPayloadSchema,
  NotifyReviewDecidedPayloadSchema,
  type NotificationKind,
} from '@cb/shared';
import type { EventProcessor, FetchedEvent } from './consumer-core.js';
import type { Tx } from './db-tx.js';

/** notify 落库的共用要素（解析各 payload 后归一）。 */
interface NotifyRecord {
  recipientId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string;
  dedupeKey: string;
  traceId: string;
}

/** 默认外发通道（站内必落；飞书/邮件 pending 待外发器投，§5.2）。 */
const OUTBOUND_CHANNELS = ['inapp', 'lark', 'email'] as const;

/** topic → 站内通知人话（禁错误码/堆栈，硬规则②）。摘要取 payload 完成态字段。 */
function buildRecord(evt: FetchedEvent): NotifyRecord {
  switch (evt.topic) {
    case 'notify.import_completed': {
      const p = NotifyImportCompletedPayloadSchema.parse(evt.payload);
      return {
        recipientId: p.recipientId,
        kind: 'import_completed',
        title: '导入完成',
        body: `已整理 ${p.segmentCount} 段会话，去看看吧。`,
        link: p.link,
        dedupeKey: evt.eventId,
        traceId: p.traceId,
      };
    }
    case 'notify.extract_completed': {
      const p = NotifyExtractCompletedPayloadSchema.parse(evt.payload);
      return {
        recipientId: p.recipientId,
        kind: 'extract_completed',
        title: '萃取完成',
        body: `识别出 ${p.candidateCount} 个能力候选，去挑一挑。`,
        link: p.link,
        dedupeKey: evt.eventId,
        traceId: p.traceId,
      };
    }
    case 'notify.publish_completed': {
      const p = NotifyPublishCompletedPayloadSchema.parse(evt.payload);
      return {
        recipientId: p.recipientId,
        kind: 'publish_completed',
        title: '发布完成',
        body: '已提交发布，进入 Alpha 评审。',
        link: p.link,
        dedupeKey: evt.eventId,
        traceId: p.traceId,
      };
    }
    case 'notify.review_decided': {
      const p = NotifyReviewDecidedPayloadSchema.parse(evt.payload);
      const approved = p.decision === 'approved';
      return {
        recipientId: p.recipientId,
        kind: 'review_decided',
        title: approved ? '评审通过' : '评审未通过',
        body: approved
          ? '你的能力已通过评审，已在市集上架。'
          : p.rejectReason
            ? `评审未通过：${p.rejectReason}`
            : '评审未通过，可修改后重新发布。',
        link: p.link,
        dedupeKey: evt.eventId,
        traceId: p.traceId,
      };
    }
    default:
      // 非 notify.* 不该路由到此 processor（consumer 按 topic 分流）。
      throw new Error(`NotifyConsumer: unexpected topic ${evt.topic}`);
  }
}

/** 落站内通知 + 通道明细（同事务）。返回新建通知 id（或 dedupe 命中已存在行 id）。 */
async function persistNotification(tx: Tx, rec: NotifyRecord): Promise<string | null> {
  // ① 站内通知（dedupe：同 recipient+event_id 只一条；at-least-once 重放不重复）。
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO notifications (recipient_id, kind, title, body, link, dedupe_key, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (recipient_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [rec.recipientId, rec.kind, rec.title, rec.body, rec.link, rec.dedupeKey, rec.traceId],
  );
  const notifId = ins.rows[0]?.id ?? null;
  if (!notifId) {
    // dedupe 命中（重放）：通知已存在，通道也已建过，幂等返回（不重复建通道）。
    return null;
  }
  // ② 通道明细：inapp 落库即成功；lark/email pending 待外发（uq_notif_channel 幂等）。
  for (const channel of OUTBOUND_CHANNELS) {
    const status = channel === 'inapp' ? 'sent' : 'pending';
    const sentAt = channel === 'inapp' ? 'now()' : 'NULL';
    await tx.query(
      `INSERT INTO notification_channels (notification_id, channel, status, sent_at)
       VALUES ($1, $2, $3, ${sentAt})
       ON CONFLICT (notification_id, channel) DO NOTHING`,
      [notifId, channel, status],
    );
  }
  return notifId;
}

/** NotifyConsumer processor（按 topic 解析 payload → 落站内通知 + 通道，同 cursor 事务）。 */
export const notifyConsumer: EventProcessor = async (tx: Tx, evt: FetchedEvent): Promise<void> => {
  const rec = buildRecord(evt);
  await persistNotification(tx, rec);
};
