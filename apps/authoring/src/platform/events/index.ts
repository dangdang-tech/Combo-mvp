// 事件管道引擎汇出（领域无关机制，B-13~B-16）。outbox / consumer 框架 / sweeper 框架 / 单实例锁 / 事务。
//   业务投影（市集投影 = modules/publish、通知消费/仓储/路由 = modules/notifications）已移出 events。
//   topic→processor 路由表（机制 import 业务）在 processes/event-routes.ts 组装，不在引擎内硬 import 业务。
export * from './db-tx.js';
export * from './outbox.js';
export * from './consumer-core.js';
export * from './single-instance.js';
export * from './sweeper-core.js';
