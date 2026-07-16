// 一轮生成的无锁编排：每轮独立持久化与收尾，HTTP 提交后在进程内异步执行。
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import type { RuntimeDb } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import type { SessionEventBus } from '../../platform/infra/event-bus.js';
import type { InterruptBus } from '../../platform/infra/redis-interrupt-bus.js';
import type { SessionEventLog } from './event-log.js';
import {
  appendTurnMessage,
  getMessages,
  type MessageRecord,
  type SessionRow,
} from '../session/repo.js';
import { createArtifactTool, type ArtifactAgentTool } from '../artifact/tool.js';
import { createTurnEmitter, type TurnEmitter, type TurnLogger } from './turn-emitter.js';
import {
  createTurn,
  finishTurnCas,
  hasRunningTurn,
  sweepExpiredTurns,
  TURN_ABANDON_AFTER_MS,
} from './turn-repo.js';

export interface TurnAgentInput {
  definition: CapabilityDefinition;
  history: MessageRecord[];
  tools: ArtifactAgentTool[];
}
export interface TurnAgent {
  subscribeTextDelta(fn: (delta: string) => void): () => void;
  subscribeActivity?(fn: () => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  transcript(): unknown[];
  runtimeError(): string | undefined;
}
export type TurnAgentFactory = (input: TurnAgentInput) => TurnAgent;
export class TurnAgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnAgentUnavailableError';
  }
}

export interface TurnRunnerDeps {
  db: RuntimeDb;
  objectStore: RuntimeObjectStore;
  bus: SessionEventBus;
  eventLog: SessionEventLog;
  agentFactory: TurnAgentFactory;
  idleTimeoutMs: number;
  interrupts: InterruptBus;
  sweepIntervalMs?: number;
  log: TurnLogger;
}
export type StartTurnResult = { status: 'started'; userMessage: MessageRecord };
export interface TurnRunner {
  startTurn(input: {
    session: SessionRow;
    definition: CapabilityDefinition;
    text: string;
    log: TurnLogger;
  }): Promise<StartTurnResult>;
  interrupt(sessionId: string): Promise<boolean>;
  dispose(): void;
}

function agentMessageToRow(m: unknown): { role: 'assistant' | 'tool'; content: unknown[] } | null {
  if (typeof m !== 'object' || m === null) return null;
  const msg = m as {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
  if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.length > 0)
    return { role: 'assistant', content: msg.content };
  if (msg.role === 'toolResult')
    return {
      role: 'tool',
      content: [
        {
          type: 'toolResult',
          toolCallId: String(msg.toolCallId ?? ''),
          toolName: String(msg.toolName ?? ''),
          content: Array.isArray(msg.content) ? msg.content : [],
          isError: Boolean(msg.isError),
        },
      ],
    };
  return null;
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const active = new Map<string, AbortController>();
  const unsubscribeInterrupts = deps.interrupts.subscribe((sessionId) =>
    active.get(sessionId)?.abort(),
  );
  const sweepTimer =
    deps.sweepIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void (async () => {
            try {
              const swept = await sweepExpiredTurns(
                deps.db,
                new Date(Date.now() - TURN_ABANDON_AFTER_MS),
              );
              for (const turn of swept) {
                const emitter = createTurnEmitter({
                  eventLog: deps.eventLog,
                  bus: deps.bus,
                  sessionId: turn.sessionId,
                  log: deps.log,
                });
                emitter.emit({
                  type: EventType.RUN_ERROR,
                  threadId: turn.sessionId,
                  runId: turn.id,
                  message: '服务异常中断,本轮已终止,请重试。',
                });
                await emitter.flush();
              }
            } catch (err) {
              deps.log.error({ err }, 'turn sweep failed');
            }
          })();
        }, deps.sweepIntervalMs);
  sweepTimer?.unref?.();

  async function executeTurn(args: {
    sessionId: string;
    definition: CapabilityDefinition;
    text: string;
    controller: AbortController;
    runId: string;
    log: TurnLogger;
  }): Promise<void> {
    const { sessionId, controller, log, runId } = args;
    const emitter: TurnEmitter = createTurnEmitter({
      eventLog: deps.eventLog,
      bus: deps.bus,
      sessionId,
      log,
    });
    const messageId = randomUUID();
    const base = { threadId: sessionId, runId };
    let nextIdx = 1;
    let assistantText = '';
    let textOpen = false;
    const openText = (): void => {
      if (!textOpen) {
        textOpen = true;
        emitter.emit({ type: EventType.TEXT_MESSAGE_START, ...base, messageId, role: 'assistant' });
      }
    };
    const closeText = (): void => {
      if (textOpen) {
        textOpen = false;
        emitter.emit({ type: EventType.TEXT_MESSAGE_END, ...base, messageId });
      }
    };

    const finishFailed = async (userMessage: string, failedContent?: unknown[]): Promise<void> => {
      closeText();
      await appendTurnMessage(deps.db, {
        sessionId,
        turnId: runId,
        idx: nextIdx++,
        role: 'assistant',
        content: failedContent ?? [{ type: 'text', text: userMessage }],
        status: 'failed',
      }).catch((err) => log.error({ err }, 'persist failed message failed'));
      const ok = await finishTurnCas(deps.db, {
        id: runId,
        status: 'failed',
        lastError: { code: 'TURN_FAILED', message: userMessage },
      });
      if (!ok) {
        log.error({ runId }, 'turn terminal state already claimed');
        return;
      }
      emitter.emit({ type: EventType.RUN_ERROR, ...base, message: userMessage });
      await emitter.flush();
    };
    const finishInterrupted = async (): Promise<void> => {
      closeText();
      const message = '本轮生成已打断。';
      await appendTurnMessage(deps.db, {
        sessionId,
        turnId: runId,
        idx: nextIdx++,
        role: 'assistant',
        content: assistantText
          ? [{ type: 'text', text: assistantText }]
          : [{ type: 'text', text: message }],
        status: 'failed',
      }).catch((err) => log.error({ err }, 'persist interrupted message failed'));
      const ok = await finishTurnCas(deps.db, {
        id: runId,
        status: 'interrupted',
        lastError: { code: 'TURN_FAILED', message },
      });
      if (!ok) {
        log.error({ runId }, 'turn terminal state already claimed');
        return;
      }
      emitter.emit({ type: EventType.RUN_ERROR, ...base, message });
      await emitter.flush();
    };

    emitter.emit({ type: EventType.RUN_STARTED, ...base });
    let history: MessageRecord[];
    try {
      const all = await getMessages(deps.db, sessionId);
      history = all.filter((m) =>
        m.turnId ? m.turnStatus === 'completed' : m.status === 'completed',
      );
    } catch (err) {
      log.error({ err }, 'load history failed');
      await finishFailed('服务开小差了，请重试。');
      return;
    }
    const tools = [
      createArtifactTool({
        db: deps.db,
        objectStore: deps.objectStore,
        sessionId,
        onArtifact: (artifact) =>
          emitter.emit({
            type: EventType.STATE_DELTA,
            ...base,
            delta: [
              { op: 'add', path: `/artifacts/${artifact.id}`, value: artifact },
              { op: 'add', path: '/activeArtifactId', value: artifact.id },
            ],
          }),
      }),
    ];
    let agent: TurnAgent;
    try {
      agent = deps.agentFactory({ definition: args.definition, history, tools });
    } catch (err) {
      const message =
        err instanceof TurnAgentUnavailableError ? err.message : '对话服务暂时不可用，请重试。';
      log.error({ err }, 'agent factory failed');
      await finishFailed(message);
      return;
    }

    const onAbort = (): void => agent.abort();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) agent.abort();
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleWatchdog = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        log.error({ idleTimeoutMs: deps.idleTimeoutMs }, 'turn idle watchdog fired, aborting');
        controller.abort();
      }, deps.idleTimeoutMs);
      idleTimer.unref?.();
    };
    const unsubscribe = agent.subscribeTextDelta((delta) => {
      armIdleWatchdog();
      openText();
      assistantText += delta;
      emitter.emit({ type: EventType.TEXT_MESSAGE_CONTENT, ...base, messageId, delta });
    });
    const unsubscribeActivity = agent.subscribeActivity?.(armIdleWatchdog);
    const finishAborted = (): Promise<void> =>
      idleTimedOut
        ? finishFailed(
            `模型响应停滞超过 ${Math.round(deps.idleTimeoutMs / 1000)} 秒，本轮已终止，请重试。`,
            assistantText ? [{ type: 'text', text: assistantText }] : undefined,
          )
        : finishInterrupted();
    armIdleWatchdog();
    try {
      await agent.prompt(args.text);
    } catch (err) {
      if (controller.signal.aborted) {
        await finishAborted();
        return;
      }
      log.error({ err }, 'agent.prompt failed');
      await finishFailed('对话生成失败，请重试。');
      return;
    } finally {
      clearTimeout(idleTimer);
      unsubscribe();
      unsubscribeActivity?.();
      controller.signal.removeEventListener('abort', onAbort);
    }
    if (controller.signal.aborted) {
      await finishAborted();
      return;
    }
    const runtimeError = agent.runtimeError();
    if (runtimeError !== undefined) {
      log.error({ runtimeError }, 'llm runtime failure (encoded in message)');
      await finishFailed('模型调用失败（额度/网络/服务波动），请重试。');
      return;
    }
    closeText();
    try {
      const fresh = agent.transcript().slice(history.length + 1);
      for (const m of fresh) {
        const row = agentMessageToRow(m);
        if (row)
          await appendTurnMessage(deps.db, {
            sessionId,
            turnId: runId,
            idx: nextIdx++,
            ...row,
            status: 'completed',
          });
      }
    } catch (err) {
      log.error({ err }, 'persist turn messages failed');
      await finishFailed('本轮回复未能保存（数据库异常），请重试。');
      return;
    }
    const ok = await finishTurnCas(deps.db, { id: runId, status: 'completed' });
    if (!ok) {
      log.error({ runId }, 'turn terminal state already claimed');
      return;
    }
    emitter.emit({ type: EventType.RUN_FINISHED, ...base });
    await emitter.flush();
  }

  return {
    async startTurn(input) {
      const sessionId = input.session.id;
      const runId = randomUUID();
      await createTurn(deps.db, { id: runId, sessionId });
      let userMessage: MessageRecord;
      try {
        userMessage = await appendTurnMessage(deps.db, {
          sessionId,
          turnId: runId,
          idx: 0,
          role: 'user',
          content: [{ type: 'text', text: input.text }],
          status: 'completed',
        });
      } catch (err) {
        await finishTurnCas(deps.db, {
          id: runId,
          status: 'failed',
          lastError: {
            code: 'SUBMIT_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        }).catch(() => false);
        throw err;
      }
      const controller = new AbortController();
      active.set(sessionId, controller);
      void executeTurn({
        sessionId,
        definition: input.definition,
        text: input.text,
        controller,
        runId,
        log: input.log,
      })
        .catch((err) => input.log.error({ err }, 'turn crashed'))
        .finally(() => {
          if (active.get(sessionId) === controller) active.delete(sessionId);
        });
      return { status: 'started', userMessage };
    },
    async interrupt(sessionId) {
      const controller = active.get(sessionId);
      if (controller) {
        controller.abort();
        return true;
      }
      if (!(await hasRunningTurn(deps.db, sessionId))) return false;
      deps.interrupts.publish(sessionId);
      return true;
    },
    dispose() {
      clearInterval(sweepTimer);
      unsubscribeInterrupts();
    },
  };
}
