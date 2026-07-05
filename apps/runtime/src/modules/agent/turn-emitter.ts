// 轮次事件双写 emitter：每个 AG-UI 事件 INSERT stream_events（表是真源，拿到自增 id）
//   → 再发进程内总线给在线 SSE 订阅者。promise 链串行化保证表内 id 顺序与事件顺序一致。
//   单条写失败：记日志、跳过该事件继续（推流尽力而为，不让观测面故障翻掉生成主流程）。
import type { Queryable } from '../../platform/infra/db.js';
import type { SessionEventBus } from '../../platform/infra/event-bus.js';
import { insertStreamEvent } from './event-log.js';

export interface TurnLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface TurnEmitter {
  /** 双写一个 AG-UI 事件（异步入链，调用点不等待）。 */
  emit(event: Record<string, unknown>): void;
  /** 等待链上所有事件写完（轮次收尾时调用，保证终态事件先于函数返回落表）。 */
  flush(): Promise<void>;
}

export function createTurnEmitter(deps: {
  db: Queryable;
  bus: SessionEventBus;
  sessionId: string;
  log: TurnLogger;
}): TurnEmitter {
  let chain = Promise.resolve();

  return {
    emit(event) {
      chain = chain.then(async () => {
        try {
          const id = await insertStreamEvent(deps.db, { sessionId: deps.sessionId, event });
          deps.bus.publish(deps.sessionId, { id, event });
        } catch (err) {
          deps.log.error({ err, event: event.type }, 'stream event write failed (skipped)');
        }
      });
    },
    flush: () => chain,
  };
}
