import type { Pool } from 'pg';
import { EventType } from '@ag-ui/core';
import type { AguiEmitter } from '../agent/agui-emitter.js';
import { appendRunEvent } from './repo.js';

export interface EventLogEmitterInput {
  pool: Pool;
  threadId: string;
  runId: string;
  signal: AbortSignal;
}

export function createEventLogEmitter(input: EventLogEmitterInput): AguiEmitter {
  let chain = Promise.resolve();
  let closed = false;

  const enqueue = (event: Record<string, unknown>): void => {
    if (closed) return;
    chain = chain.then(() => appendRunEvent(input.pool, input.runId, event).then(() => undefined));
  };

  return {
    runStarted: () =>
      enqueue({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId }),
    textStart: (messageId) =>
      enqueue({
        type: EventType.TEXT_MESSAGE_START,
        threadId: input.threadId,
        runId: input.runId,
        messageId,
        role: 'assistant',
      }),
    textContent: (messageId, delta) =>
      enqueue({
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId: input.threadId,
        runId: input.runId,
        messageId,
        delta,
      }),
    textEnd: (messageId) =>
      enqueue({
        type: EventType.TEXT_MESSAGE_END,
        threadId: input.threadId,
        runId: input.runId,
        messageId,
      }),
    stateDelta: (ops) =>
      enqueue({
        type: EventType.STATE_DELTA,
        threadId: input.threadId,
        runId: input.runId,
        delta: ops,
      }),
    stateSnapshot: (snapshot) =>
      enqueue({
        type: EventType.STATE_SNAPSHOT,
        threadId: input.threadId,
        runId: input.runId,
        snapshot,
      }),
    runError: (message) =>
      enqueue({ type: EventType.RUN_ERROR, threadId: input.threadId, runId: input.runId, message }),
    runFinished: () =>
      enqueue({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId }),
    flush: async () => {
      await chain;
    },
    end: () => {
      closed = true;
    },
    signal: input.signal,
  };
}
