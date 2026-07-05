// 进程内会话事件总线：run-turn 双写的「在线订阅者」一侧（另一侧 INSERT stream_events 才是真源）。
//   runtime 是单进程（api 进程内异步跑生成），进程内订阅即可覆盖全部在线连接；
//   若未来拆多进程，把本接口换成 Redis 发布/订阅实现即可，SSE 端订阅面不变。
export interface PublishedStreamEvent {
  /** stream_events.id（bigserial），= SSE 帧 id / Last-Event-ID 续传锚点。 */
  id: number;
  /** AG-UI 标准事件对象（与表里 event 列同一份）。 */
  event: Record<string, unknown>;
}

export interface SessionEventBus {
  publish(sessionId: string, event: PublishedStreamEvent): void;
  /** 订阅某会话的实时事件；返回退订函数。 */
  subscribe(sessionId: string, fn: (event: PublishedStreamEvent) => void): () => void;
}

export function createSessionEventBus(): SessionEventBus {
  const listeners = new Map<string, Set<(event: PublishedStreamEvent) => void>>();
  return {
    publish(sessionId, event) {
      const set = listeners.get(sessionId);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(event);
        } catch {
          // 单个订阅者异常不影响其他订阅者与发布方。
        }
      }
    },
    subscribe(sessionId, fn) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
  };
}
