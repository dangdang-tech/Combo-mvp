// 基础设施容器：db / objectStore / 会话事件总线聚成一个上下文，注入 Fastify（app.decorate('infra')）。
// 业务 handler 经 req.server.infra 取用；TurnRunner 在 bootstrap 组装（依赖 modules/agent，不在本层建）。
import type { Env } from '../config/env.js';
import { getPool, toRuntimeDb, type RuntimeDb } from './db.js';
import { createS3ObjectStore, type RuntimeObjectStore } from './object-store.js';
import { createRedisSessionEventBus, type SessionEventBus } from './event-bus.js';
import { createRedisSessionEventLog } from './redis-event-log.js';
import type { SessionEventLog } from '../../modules/agent/event-log.js';

export interface InfraContext {
  env: Env;
  db: RuntimeDb;
  objectStore: RuntimeObjectStore;
  bus: SessionEventBus;
  eventLog: SessionEventLog;
}

/** 组装基础设施上下文（惰性客户端，不在启动期强连）。 */
export function buildInfra(env: Env): InfraContext {
  return {
    env,
    db: toRuntimeDb(getPool(env)),
    objectStore: createS3ObjectStore(env),
    bus: createRedisSessionEventBus(env),
    eventLog: createRedisSessionEventLog(env),
  };
}

export * from './db.js';
export * from './object-store.js';
export * from './event-bus.js';
export * from './llm.js';
export * from './logto.js';
export * from './dev-session.js';
export * from './redis.js';
export * from './redis-interrupt-bus.js';
export * from './redis-event-log.js';
