// 一轮生成的自治编排：数据库限制单 Session 单 running Turn，HTTP 提交后在进程内异步执行。
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition, SessionMode } from '@cb/shared';
import { withTransaction, type RuntimeDb } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import type { PublishedStreamEvent, SessionEventBus } from '../../platform/infra/event-bus.js';
import type { InterruptBus } from '../../platform/infra/redis-interrupt-bus.js';
import {
  createDisabledSandboxBackend,
  SandboxBackendError,
  type SandboxBackend,
} from '../../platform/infra/sandbox-backend.js';
import type { SessionEventLog } from './event-log.js';
import {
  appendTurnMessage,
  getMessages,
  lockActiveSession,
  type MessageRecord,
  type SessionRow,
} from '../session/repo.js';
import { createArtifactTool, type ArtifactAgentTool } from '../artifact/tool.js';
import { bindCapabilityUiArtifact } from '../artifact/repo.js';
import { createSandboxTools, type SandboxAgentTool } from './sandbox-tools.js';
import { createTurnEmitter, type TurnEmitter, type TurnLogger } from './turn-emitter.js';
import {
  createTurn,
  finishTurnCas,
  finishTurnWithMessage,
  getRunningTurnId,
  lockRunningTurn,
  lockTurnSession,
  sweepExpiredTurns,
  TURN_ABANDON_AFTER_MS,
} from './turn-repo.js';

export type RuntimeAgentTool = ArtifactAgentTool | SandboxAgentTool;

export interface TurnAgentInput {
  definition: CapabilityDefinition;
  mode: SessionMode;
  history: MessageRecord[];
  tools: RuntimeAgentTool[];
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

export class SessionInactiveError extends Error {
  constructor() {
    super('session is no longer active');
    this.name = 'SessionInactiveError';
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
  sandbox?: SandboxBackend;
  sweepIntervalMs?: number;
  shutdownTimeoutMs?: number;
  terminalEventTimeoutMs?: number;
  sandboxCleanupTimeoutMs?: number;
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
  dispose(signal?: AbortSignal): Promise<void>;
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

class TerminalEventAppendTimeoutError extends Error {
  constructor() {
    super('terminal Redis event append outcome is unknown');
    this.name = 'TerminalEventAppendTimeoutError';
  }
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function waitUntilSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => resolve(undefined));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const sandbox = deps.sandbox ?? createDisabledSandboxBackend();
  interface ActiveTurn {
    controller: AbortController;
    runId: string;
    completion: Promise<void>;
  }
  const active = new Map<string, ActiveTurn>();
  const sandboxStops = new Map<string, Promise<void>>();
  const shutdownOwnedRuns = new Set<string>();
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 15_000;
  const terminalEventTimeoutMs = deps.terminalEventTimeoutMs ?? 3_000;
  const sandboxCleanupTimeoutMs = deps.sandboxCleanupTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new Error('turn shutdown timeout must be positive');
  }
  if (!Number.isSafeInteger(terminalEventTimeoutMs) || terminalEventTimeoutMs <= 0) {
    throw new Error('terminal event timeout must be positive');
  }
  if (!Number.isSafeInteger(sandboxCleanupTimeoutMs) || sandboxCleanupTimeoutMs <= 0) {
    throw new Error('sandbox cleanup timeout must be positive');
  }
  const promptAbortGraceMs = Math.max(1, Math.min(1_000, Math.floor(shutdownTimeoutMs / 2)));
  let disposing = false;
  let disposePromise: Promise<void> | undefined;
  const appendTerminalEvent = async (
    sessionId: string,
    runId: string,
    event: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PublishedStreamEvent> => {
    if (signal?.aborted) throw new TerminalEventAppendTimeoutError();
    const timeout = terminalEventTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const append = deps.eventLog.appendTerminal(sessionId, runId, event);
    try {
      const id = await Promise.race([
        append,
        new Promise<never>((_resolve, reject) => {
          const fail = (): void => reject(new TerminalEventAppendTimeoutError());
          timer = setTimeout(fail, timeout);
          timer.unref?.();
          if (signal) {
            onAbort = fail;
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }),
      ]);
      return { id, event };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
  const stopSandboxCommands = (
    sessionId: string,
    reason: string,
    options: { localExecution?: boolean } = {},
  ): Promise<void> => {
    // A feature-off replica knows that its own local Turn never received remote
    // tools, but it cannot certify cleanup for a Turn owned by an enabled replica.
    if (!sandbox.enabled) {
      return options.localExecution
        ? Promise.resolve()
        : Promise.reject(
            new SandboxBackendError(
              'cleanup_unconfirmed',
              'this Runtime replica cannot verify foreign sandbox cleanup',
            ),
          );
    }
    const existing = sandboxStops.get(sessionId);
    if (existing) return existing;
    let timer: NodeJS.Timeout | undefined;
    const pending = Promise.race([
      sandbox.interruptSession(sessionId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('sandbox cleanup timed out')),
          sandboxCleanupTimeoutMs,
        );
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    sandboxStops.set(sessionId, pending);
    void pending
      .catch((err) => {
        deps.log.error({ err, sessionId, reason }, 'sandbox interrupt failed');
      })
      .finally(() => {
        if (sandboxStops.get(sessionId) === pending) sandboxStops.delete(sessionId);
      });
    return pending;
  };
  const unsubscribeInterrupts = deps.interrupts.subscribe((sessionId) => {
    const running = active.get(sessionId);
    running?.controller.abort();
    if (running) {
      void stopSandboxCommands(sessionId, 'interrupt-broadcast', {
        localExecution: true,
      }).catch(() => undefined);
    }
  });
  let sweepInFlight: Promise<void> | undefined;
  const sweepTimer =
    deps.sweepIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          if (sweepInFlight) return;
          const run = (async () => {
            try {
              const terminalEvents = new Map<string, PublishedStreamEvent>();
              const swept = await sweepExpiredTurns(
                deps.db,
                new Date(Date.now() - TURN_ABANDON_AFTER_MS),
                {
                  beforeFinish: async (turn) => {
                    deps.interrupts.publish(turn.sessionId);
                    // The Session row remains locked until sandboxd confirms its
                    // descendant sweep or the exact Pod UID is observed gone.
                    await stopSandboxCommands(turn.sessionId, 'turn-sweep', {
                      localExecution: active.get(turn.sessionId)?.runId === turn.id,
                    });
                    const event = {
                      type: EventType.RUN_ERROR,
                      threadId: turn.sessionId,
                      runId: turn.id,
                      message: '服务异常中断,本轮已终止,请重试。',
                    };
                    terminalEvents.set(
                      turn.id,
                      await appendTerminalEvent(turn.sessionId, turn.id, event),
                    );
                  },
                },
              );
              // XADD happens while the Session row is locked; live publication
              // waits for the terminal DB transaction to commit. A newer Turn's
              // RUN_STARTED therefore always has a larger Redis Stream id.
              for (const turn of swept) {
                const terminal = terminalEvents.get(turn.id);
                if (terminal) deps.bus.publish(turn.sessionId, terminal);
              }
            } catch (err) {
              deps.log.error({ err }, 'turn sweep failed');
            }
          })().finally(() => {
            if (sweepInFlight === run) sweepInFlight = undefined;
          });
          sweepInFlight = run;
          void run;
        }, deps.sweepIntervalMs);
  sweepTimer?.unref?.();

  async function executeTurn(args: {
    sessionId: string;
    capabilityId: string;
    definition: CapabilityDefinition;
    mode: SessionMode;
    text: string;
    controller: AbortController;
    runId: string;
    ownerUserId: string;
    log: TurnLogger;
  }): Promise<void> {
    const { sessionId, controller, log, runId } = args;
    const localHandle = active.get(sessionId);
    if (localHandle?.runId !== runId || (await getRunningTurnId(deps.db, sessionId)) !== runId) {
      return;
    }
    const emitter: TurnEmitter = createTurnEmitter({
      eventLog: deps.eventLog,
      bus: deps.bus,
      sessionId,
      log,
      append: async (event) => {
        if (controller.signal.aborted || shutdownOwnedRuns.has(runId)) return null;
        return withTransaction(
          deps.db,
          async (transaction) => {
            // Every nonterminal event uses the same Session-before-Turn lock order as
            // terminalization. Once any replica commits a terminal CAS, later Pi
            // output cannot obtain this running guard and therefore cannot reach SSE.
            await lockTurnSession(transaction, sessionId);
            if (controller.signal.aborted || shutdownOwnedRuns.has(runId)) return null;
            if (!(await lockRunningTurn(transaction, runId, sessionId))) return null;
            return deps.eventLog.append(sessionId, event);
          },
          { signal: controller.signal },
        );
      },
    });
    const messageId = randomUUID();
    const base = { threadId: sessionId, runId };
    let nextIdx = 1;
    let assistantText = '';
    let lastStudioArtifactId: string | null = null;
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
      if (shutdownOwnedRuns.has(runId)) return;
      closeText();
      if (shutdownOwnedRuns.has(runId)) return;
      const event = { type: EventType.RUN_ERROR, ...base, message: userMessage };
      let terminal: PublishedStreamEvent | undefined;
      let ok: boolean;
      try {
        await emitter.flush();
        if (shutdownOwnedRuns.has(runId)) return;
        ok = await finishTurnWithMessage(
          deps.db,
          {
            id: runId,
            sessionId,
            idx: nextIdx++,
            status: 'failed',
            content: failedContent ?? [{ type: 'text', text: userMessage }],
            lastError: { code: 'TURN_FAILED', message: userMessage },
          },
          {
            beforeFinish: async () => {
              terminal = await appendTerminalEvent(sessionId, runId, event);
            },
          },
        );
      } catch (err) {
        log.error({ err }, 'persist failed terminal state failed');
        return;
      }
      if (!ok || !terminal) {
        log.error({ runId }, 'turn terminal state already claimed');
        return;
      }
      deps.bus.publish(sessionId, terminal);
    };
    const finishInterrupted = async (): Promise<void> => {
      if (shutdownOwnedRuns.has(runId)) return;
      closeText();
      if (shutdownOwnedRuns.has(runId)) return;
      const message = '本轮生成已打断。';
      const event = { type: EventType.RUN_ERROR, ...base, message };
      let terminal: PublishedStreamEvent | undefined;
      let ok: boolean;
      try {
        await emitter.flush();
        if (shutdownOwnedRuns.has(runId)) return;
        ok = await finishTurnWithMessage(
          deps.db,
          {
            id: runId,
            sessionId,
            idx: nextIdx++,
            status: 'interrupted',
            content: assistantText
              ? [{ type: 'text', text: assistantText }]
              : [{ type: 'text', text: message }],
            lastError: { code: 'TURN_FAILED', message },
          },
          {
            beforeFinish: async () => {
              terminal = await appendTerminalEvent(sessionId, runId, event);
            },
          },
        );
      } catch (err) {
        log.error({ err }, 'persist interrupted terminal state failed');
        return;
      }
      if (!ok || !terminal) {
        log.error({ runId }, 'turn terminal state already claimed');
        return;
      }
      deps.bus.publish(sessionId, terminal);
    };

    // An interrupt can win immediately after startTurn commits but before this
    // async executor reaches Pi. The local handle is published before COMMIT, so
    // keep that already-aborted execution responsible for releasing the running
    // guard instead of returning and orphaning the Turn.
    if (controller.signal.aborted) {
      const cleanupSafe = await stopSandboxCommands(sessionId, 'pre-execution-abort', {
        localExecution: true,
      }).then(
        () => true,
        (err: unknown) => {
          log.error({ err }, 'sandbox cleanup before execution failed');
          return false;
        },
      );
      if (cleanupSafe) await finishInterrupted();
      return;
    }

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
    const tools: RuntimeAgentTool[] = [
      createArtifactTool({
        db: deps.db,
        objectStore: deps.objectStore,
        sessionId,
        turnId: runId,
        turnSignal: controller.signal,
        capabilityId: args.capabilityId,
        mode: args.mode,
        onArtifact: (artifact) => {
          if (args.mode === 'studio') lastStudioArtifactId = artifact.id;
          emitter.emit({
            type: EventType.STATE_DELTA,
            ...base,
            delta: [
              { op: 'add', path: `/artifacts/${artifact.id}`, value: artifact },
              { op: 'add', path: '/activeArtifactId', value: artifact.id },
            ],
          });
        },
      }),
    ];
    if (sandbox.enabled) {
      tools.push(
        ...createSandboxTools({
          backend: sandbox,
          sessionId,
          turnId: runId,
          ownerUserId: args.ownerUserId,
          turnSignal: controller.signal,
          onCleanupUnconfirmed: () => controller.abort(),
        }),
      );
    }
    let agent: TurnAgent;
    try {
      agent = deps.agentFactory({ definition: args.definition, mode: args.mode, history, tools });
    } catch (err) {
      const message =
        err instanceof TurnAgentUnavailableError ? err.message : '对话服务暂时不可用，请重试。';
      log.error({ err }, 'agent factory failed');
      await finishFailed(message);
      return;
    }

    type PromptOutcome =
      | { status: 'completed' }
      | { status: 'failed'; error: unknown }
      | { status: 'aborted' };
    let resolveAbort!: (outcome: PromptOutcome) => void;
    const abortOutcome = new Promise<PromptOutcome>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = (): void => {
      try {
        agent.abort();
      } catch (err) {
        log.error({ err }, 'agent abort failed');
      }
      resolveAbort({ status: 'aborted' });
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleWatchdog = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        log.error({ idleTimeoutMs: deps.idleTimeoutMs }, 'turn idle watchdog fired, aborting');
        controller.abort();
        void stopSandboxCommands(sessionId, 'idle-timeout', { localExecution: true });
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
    let promptOutcome: PromptOutcome = { status: 'aborted' };
    let promptSettled = false;
    const prompt = Promise.resolve()
      .then(() => agent.prompt(args.text))
      .then<PromptOutcome, PromptOutcome>(
        () => ({ status: 'completed' }),
        (error: unknown) => ({ status: 'failed', error }),
      )
      .finally(() => {
        promptSettled = true;
      });
    try {
      promptOutcome = await Promise.race([prompt, abortOutcome]);
    } finally {
      clearTimeout(idleTimer);
      unsubscribe();
      unsubscribeActivity?.();
      controller.signal.removeEventListener('abort', onAbort);
    }
    if (controller.signal.aborted || promptOutcome.status === 'aborted') {
      // Give a cooperative model SDK a bounded window to finish its own abort.
      // The mapped Promise remains observed after the window, so a late reject
      // cannot resume this Turn or touch the database after shutdown.
      let graceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        prompt,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, promptAbortGraceMs);
          graceTimer.unref?.();
        }),
      ]);
      clearTimeout(graceTimer);
      // An uncooperative Pi/tool Promise may still hold an object-store write.
      // The Turn signal fences its eventual commit; remote process cleanup must
      // additionally be proven before this replica can certify a terminal state.
      if (!promptSettled) {
        const cleanupSafe = await stopSandboxCommands(sessionId, 'turn-abort', {
          localExecution: true,
        }).then(
          () => true,
          (err: unknown) => {
            log.error({ err }, 'sandbox cleanup after unresolved prompt failed');
            return false;
          },
        );
        if (!cleanupSafe) {
          log.error(
            { runId },
            'aborted prompt and sandbox cleanup did not settle; keeping Turn running',
          );
          return;
        }
        // Tool adapters fence their commit after the abort signal, so an SDK Promise
        // that ignores abort may finish in memory but cannot mutate DB/SSE/sandbox
        // after this cleanup proof and terminal CAS.
        await finishAborted();
        return;
      }
      // Do not release the running Turn until this replica has waited for
      // sandboxd cleanup or the backend's UID-conditioned Pod deletion path.
      await stopSandboxCommands(sessionId, 'turn-abort', { localExecution: true });
      await finishAborted();
      return;
    }
    if (promptOutcome.status === 'failed') {
      log.error({ err: promptOutcome.error }, 'agent.prompt failed');
      await finishFailed('对话生成失败，请重试。');
      return;
    }
    const runtimeError = agent.runtimeError();
    if (runtimeError !== undefined) {
      log.error({ runtimeError }, 'llm runtime failure (encoded in message)');
      await finishFailed('模型调用失败（额度/网络/服务波动），请重试。');
      return;
    }
    if (shutdownOwnedRuns.has(runId)) return;
    closeText();
    const completedEvent = { type: EventType.RUN_FINISHED, ...base };
    let completedTerminal: PublishedStreamEvent | undefined;
    let completedNextIdx: number | null;
    try {
      const rows = agent
        .transcript()
        .slice(history.length + 1)
        .flatMap((message) => {
          const row = agentMessageToRow(message);
          return row ? [row] : [];
        });
      await emitter.flush();
      if (shutdownOwnedRuns.has(runId)) return;
      completedNextIdx = await withTransaction(deps.db, async (transaction) => {
        await lockTurnSession(transaction, sessionId);
        if (!(await lockRunningTurn(transaction, runId, sessionId))) return null;
        // Studio promotion is validated before creating the Redis terminal marker.
        // A deterministic binding failure can still become one ordered RUN_ERROR;
        // any failure after RUN_FINISHED keeps this runId fenced as outcome-unknown.
        if (args.mode === 'studio' && lastStudioArtifactId) {
          const bound = await bindCapabilityUiArtifact(transaction, {
            capabilityId: args.capabilityId,
            artifactId: lastStudioArtifactId,
            studioSessionId: sessionId,
          });
          if (!bound) throw new Error('Studio revision could not be promoted');
        }
        completedTerminal = await appendTerminalEvent(sessionId, runId, completedEvent);
        const won = await finishTurnCas(transaction, { id: runId, status: 'completed' });
        if (!won) return null;
        let idx = nextIdx;
        for (const row of rows) {
          await appendTurnMessage(transaction, {
            sessionId,
            turnId: runId,
            idx: idx++,
            ...row,
            status: 'completed',
          });
        }
        return idx;
      });
    } catch (err) {
      log.error({ err }, 'persist completed terminal state failed');
      if (err instanceof TerminalEventAppendTimeoutError || completedTerminal) {
        // The RUN_FINISHED append either has an unknown outcome or already returned
        // before a later database statement failed. Keep the DB Turn running and
        // never race that runId with a different RUN_ERROR terminal.
        return;
      }
      await finishFailed('本轮回复未能保存（数据库异常），请重试。');
      return;
    }
    if (completedNextIdx === null || !completedTerminal) {
      log.error({ runId }, 'turn terminal state already claimed');
      return;
    }
    nextIdx = completedNextIdx;
    deps.bus.publish(sessionId, completedTerminal);
  }

  return {
    async startTurn(input) {
      if (disposing) throw new Error('turn runner is shutting down');
      const sessionId = input.session.id;
      const runId = randomUUID();
      const controller = new AbortController();
      const running: ActiveTurn = {
        controller,
        runId,
        completion: Promise.resolve(),
      };
      let userMessage: MessageRecord;
      try {
        userMessage = await withTransaction(deps.db, async (tx) => {
          const lockedSession = await lockActiveSession(tx, sessionId, input.session.ownerUserId);
          if (!lockedSession) throw new SessionInactiveError();
          await createTurn(tx, { id: runId, sessionId });
          const message = await appendTurnMessage(tx, {
            sessionId,
            turnId: runId,
            idx: 0,
            role: 'user',
            content: [{ type: 'text', text: input.text }],
            status: 'completed',
          });
          // Publish the local handle before COMMIT. A concurrent interrupt waits on
          // the Session row, then can verify this exact runId instead of falling
          // through the post-commit/pre-handle gap.
          active.set(sessionId, running);
          return message;
        });
      } catch (err) {
        if (active.get(sessionId) === running) active.delete(sessionId);
        // A failed or outcome-unknown COMMIT must not be followed by an unlocked
        // terminal CAS. If the Turn actually committed, keep it running so the
        // normal locked sweeper can reconcile it without unordered SSE events.
        throw err;
      }
      running.completion = executeTurn({
        sessionId,
        capabilityId: input.session.capabilityId,
        definition: input.definition,
        mode: input.session.mode,
        text: input.text,
        controller,
        runId,
        ownerUserId: input.session.ownerUserId,
        log: input.log,
      })
        .catch((err) => input.log.error({ err }, 'turn crashed'))
        .finally(() => {
          if (active.get(sessionId) === running) active.delete(sessionId);
        });
      return { status: 'started', userMessage };
    },
    async interrupt(sessionId) {
      const runId = await withTransaction(deps.db, async (transaction) => {
        // Linearize against startTurn, archive and terminal paths on the Session
        // row. In particular, wait for a just-created Turn's COMMIT instead of
        // falsely returning `interrupted: false` during the pre-commit window.
        await lockTurnSession(transaction, sessionId);
        return getRunningTurnId(transaction, sessionId);
      });
      if (!runId) return false;
      // Read the handle after the Session-locked database lookup. startTurn may
      // have published it while this request was waiting for COMMIT.
      const local = active.get(sessionId);
      if (local?.runId === runId) {
        local.controller.abort();
        await stopSandboxCommands(sessionId, 'local-interrupt', { localExecution: true });
        return true;
      }
      const message = '本轮生成已打断。';
      const event = {
        type: EventType.RUN_ERROR,
        threadId: sessionId,
        runId,
        message,
      };
      let terminal: PublishedStreamEvent | undefined;
      const won = await finishTurnWithMessage(
        deps.db,
        {
          id: runId,
          sessionId,
          idx: 1,
          status: 'interrupted',
          content: [{ type: 'text', text: message }],
          lastError: { code: 'TURN_FAILED', message },
        },
        {
          beforeFinish: async () => {
            // The Session and running Turn rows stay locked until the remote
            // process namespace is gone and the ordered terminal event exists.
            deps.interrupts.publish(sessionId);
            await stopSandboxCommands(sessionId, 'cross-replica-interrupt');
            terminal = await appendTerminalEvent(sessionId, runId, event);
          },
        },
      );
      if (won && terminal) deps.bus.publish(sessionId, terminal);
      return won;
    },
    dispose(externalSignal) {
      if (disposePromise) return disposePromise;
      disposing = true;
      const deadline = Date.now() + shutdownTimeoutMs;
      const localDeadline = AbortSignal.timeout(shutdownTimeoutMs);
      const shutdownSignal = externalSignal
        ? AbortSignal.any([externalSignal, localDeadline])
        : localDeadline;
      disposePromise = (async () => {
        clearInterval(sweepTimer);
        unsubscribeInterrupts();
        const runningTurns = [...active.entries()];
        const cleanupStates = new Map<string, 'pending' | 'safe' | 'failed'>();
        const stopping: Promise<unknown>[] = sweepInFlight ? [sweepInFlight] : [];
        for (const [sessionId, running] of runningTurns) {
          shutdownOwnedRuns.add(running.runId);
          cleanupStates.set(sessionId, 'pending');
          running.controller.abort();
          const cleanup = stopSandboxCommands(sessionId, 'runtime-shutdown', {
            localExecution: true,
          }).then(
            () => cleanupStates.set(sessionId, 'safe'),
            (err: unknown) => {
              cleanupStates.set(sessionId, 'failed');
              deps.log.error({ err, sessionId }, 'runtime shutdown sandbox cleanup failed');
            },
          );
          stopping.push(cleanup, running.completion);
        }
        await waitUntilSignal(Promise.allSettled(stopping), shutdownSignal);

        if (!shutdownSignal.aborted) {
          const terminalFallbacks = runningTurns.map(async ([sessionId, running]) => {
            if (cleanupStates.get(sessionId) !== 'safe') {
              deps.log.error(
                { sessionId, runId: running.runId },
                'shutdown kept Turn running because sandbox cleanup was unconfirmed',
              );
              return;
            }
            const remaining = remainingMilliseconds(deadline);
            if (remaining <= 0 || shutdownSignal.aborted) return;
            const message = 'Runtime 正在关闭，本轮已终止，请重试。';
            const event = {
              type: EventType.RUN_ERROR,
              threadId: sessionId,
              runId: running.runId,
              message,
            };
            let terminal: PublishedStreamEvent | undefined;
            const won = await finishTurnWithMessage(
              deps.db,
              {
                id: running.runId,
                sessionId,
                idx: 1,
                status: 'interrupted',
                content: [{ type: 'text', text: message }],
                lastError: { code: 'TURN_FAILED', message },
              },
              {
                transaction: { signal: shutdownSignal, timeoutMs: remaining },
                beforeFinish: async () => {
                  terminal = await appendTerminalEvent(
                    sessionId,
                    running.runId,
                    event,
                    shutdownSignal,
                  );
                },
              },
            ).catch((err) => {
              deps.log.error({ err, runId: running.runId }, 'shutdown terminal fallback failed');
              return false;
            });
            if (won && terminal && !shutdownSignal.aborted) deps.bus.publish(sessionId, terminal);
          });
          await waitUntilSignal(Promise.allSettled(terminalFallbacks), shutdownSignal);
        }
        active.clear();
      })();
      return disposePromise;
    },
  };
}
