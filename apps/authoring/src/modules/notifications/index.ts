// notifications（通知）域唯一对外出口（跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：routes/index.ts 注册路由、processes/event-routes.ts 组装 NotifyConsumer 到 consumer 路由表。
//   - NotifyConsumer processor：消费 notify.* 事件，落站内通知 + 通道（机制侧由 event-routes 注入路由表）。
//   - /notifications 路由：本人通知读 / 标已读 / 全部已读 / 未读数（B-35，70 §5.4）。
//   - repo：通知读写仓储（路由内部用；对外暴露便于复用/测试）。
export { notifyConsumer } from './consumer.js';
export { NOTIFICATION_ENDPOINTS, registerNotificationRoutes } from './routes.js';
export {
  listNotifications,
  markRead,
  markAllRead,
  unreadCount,
  type ListNotificationsParams,
  type ListNotificationsResult,
} from './repo.js';
