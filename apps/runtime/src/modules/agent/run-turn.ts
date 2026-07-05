// 一轮生成的编排（生命周期不绑 HTTP 连接：POST messages 落完 user 消息即返回，本文件异步跑完整轮）。
//   - 会话级并发闸：单进程内 Map<sessionId, AbortController>——同会话同一时刻只跑一轮，
//     先占闸再落 user 消息（占不到 → SESSION_BUSY），interrupt 经 controller.abort() 打断。
//   - 事件：pi 事件翻成 AG-UI 标准事件，经 TurnEmitter 双写（stream_events 表 + 进程内总线）。
//   - 终态：正常结束把整轮 assistant/toolResult 消息落 messages（completed）+ RUN_FINISHED；
//     失败/打断落一条 failed 消息 + RUN_ERROR。
//   - agent 经注入的 TurnAgentFactory 构造（生产 = pi 实现见 build-agent.ts；单测注入假 agent）。
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import type { RuntimeDb } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import type { SessionEventBus } from '../../platform/infra/event-bus.js';
import {
  appendMessage,
  getMessages,
  type MessageRecord,
  type SessionRow,
} from '../session/repo.js';
import { createArtifactTool, type ArtifactAgentTool } from '../artifact/tool.js';
import { createTurnEmitter, type TurnEmitter, type TurnLogger } from './turn-emitter.js';

// ───────────────────────────── agent 注入口 ─────────────────────────────

export interface TurnAgentInput {
  definition: CapabilityDefinition;
  /** 本轮 user 消息之前的定稿历史（pi 原生格式重建由实现方负责）。 */
  history: MessageRecord[];
  tools: ArtifactAgentTool[];
}

/** run-turn 消费的最小 agent 面（pi Agent 的包装见 build-agent.ts；单测注入假实现）。 */
export interface TurnAgent {
  /** 订阅助手文本增量；返回退订函数。 */
  subscribeTextDelta(fn: (delta: string) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  /** 完整转录（历史 + 本轮 user + 本轮新消息），pi AgentMessage[] plain JSON。 */
  transcript(): unknown[];
  /** pi 把运行时失败编码进最终消息而非抛错；有失败 → 返回内部错误信息。 */
  runtimeError(): string | undefined;
}

export type TurnAgentFactory = (input: TurnAgentInput) => TurnAgent;

/** agent 不可用（如未配置模型密钥）：message 是可直接展示的人话。 */
export class TurnAgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnAgentUnavailableError';
  }
}

// ───────────────────────────── 编排器 ─────────────────────────────

export interface TurnRunnerDeps {
  db: RuntimeDb;
  objectStore: RuntimeObjectStore;
  bus: SessionEventBus;
  agentFactory: TurnAgentFactory;
}

export type StartTurnResult =
  | { status: 'busy' }
  | { status: 'started'; userMessage: MessageRecord };

export interface TurnRunner {
  /** 占闸 → 落 user 消息 → 异步启动一轮生成，立即返回。占不到闸 → busy。 */
  startTurn(input: {
    session: SessionRow;
    definition: CapabilityDefinition;
    text: string;
    log: TurnLogger;
  }): Promise<StartTurnResult>;
  /** 打断当前轮（会话保留）；无进行中的轮 → false。 */
  interrupt(sessionId: string): boolean;
  isBusy(sessionId: string): boolean;
}

/** pi 转录消息 → messages 行入参（user 已单独落、自定义消息不落 → null）。 */
function agentMessageToRow(m: unknown): { role: 'assistant' | 'tool'; content: unknown[] } | null {
  if (typeof m !== 'object' || m === null) return null;
  const msg = m as {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
  if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.length > 0) {
    return { role: 'assistant', content: msg.content };
  }
  if (msg.role === 'toolResult') {
    // pi ToolResultMessage → 单元素 toolResult 包装块（保住 toolCallId 配对，见 message-content.ts）。
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
  }
  return null;
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const active = new Map<string, AbortController>();

  async function executeTurn(args: {
    sessionId: string;
    definition: CapabilityDefinition;
    text: string;
    /** 本轮 user 消息的 seq（它之前的定稿才是历史）。 */
    userSeq: number;
    controller: AbortController;
    log: TurnLogger;
  }): Promise<void> {
    const { sessionId, controller, log } = args;
    const emitter: TurnEmitter = createTurnEmitter({ db: deps.db, bus: deps.bus, sessionId, log });
    const runId = randomUUID();
    // 流式 messageId：前端聚增量用（落库行 id 由 DB 生成，终态后前端以详情接口为真源）。
    const messageId = randomUUID();
    const base = { threadId: sessionId, runId };

    let assistantText = '';
    let textOpen = false;
    const openText = (): void => {
      if (textOpen) return;
      textOpen = true;
      emitter.emit({ type: EventType.TEXT_MESSAGE_START, ...base, messageId, role: 'assistant' });
    };
    const closeText = (): void => {
      if (!textOpen) return;
      textOpen = false;
      emitter.emit({ type: EventType.TEXT_MESSAGE_END, ...base, messageId });
    };

    /** 失败/打断统一收尾：落 failed 消息 + RUN_ERROR（终态事件必先落表再返回）。 */
    const finishFailed = async (userMessage: string, failedContent?: unknown[]): Promise<void> => {
      closeText();
      await appendMessage(deps.db, {
        sessionId,
        role: 'assistant',
        content: failedContent ?? [{ type: 'text', text: userMessage }],
        status: 'failed',
      }).catch((err) => log.error({ err }, 'persist failed message failed'));
      emitter.emit({ type: EventType.RUN_ERROR, ...base, message: userMessage });
      await emitter.flush();
    };
    const finishInterrupted = async (): Promise<void> => {
      // 已生成的部分文本保进 failed 消息，不静默丢弃。
      await finishFailed(
        '本轮生成已打断。',
        assistantText ? [{ type: 'text', text: assistantText }] : undefined,
      );
    };

    emitter.emit({ type: EventType.RUN_STARTED, ...base });

    let history: MessageRecord[];
    try {
      // 历史 = 本轮 user 消息之前的定稿；failed 消息是 UI 错误记录，不进 agent 上下文。
      const all = await getMessages(deps.db, sessionId);
      history = all.filter((m) => m.seq < args.userSeq && m.status === 'completed');
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
        // 产物更新 → AG-UI 共享状态：add /artifacts/<id>（对已存在成员即替换）+ 置活跃产物。
        onArtifact: (artifact) => {
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
    const unsubscribe = agent.subscribeTextDelta((delta) => {
      openText();
      assistantText += delta;
      emitter.emit({ type: EventType.TEXT_MESSAGE_CONTENT, ...base, messageId, delta });
    });

    try {
      await agent.prompt(args.text);
    } catch (err) {
      if (controller.signal.aborted) {
        await finishInterrupted();
        return;
      }
      log.error({ err }, 'agent.prompt failed');
      await finishFailed('对话生成失败，请重试。');
      return;
    } finally {
      unsubscribe();
      controller.signal.removeEventListener('abort', onAbort);
    }

    if (controller.signal.aborted) {
      await finishInterrupted();
      return;
    }

    // pi 把运行时失败编码进最终消息（stopReason='error'）而非抛错，显式探测。
    const runtimeError = agent.runtimeError();
    if (runtimeError !== undefined) {
      log.error({ runtimeError }, 'llm runtime failure (encoded in message)');
      await finishFailed('模型调用失败（额度/网络/服务波动），请重试。');
      return;
    }

    closeText();

    try {
      // 转录 = 历史 + 本轮 user（prompt 注入）+ 本轮新消息；只落新消息。
      const fresh = agent.transcript().slice(history.length + 1);
      for (const m of fresh) {
        const row = agentMessageToRow(m);
        if (row) {
          await appendMessage(deps.db, { sessionId, ...row, status: 'completed' });
        }
      }
    } catch (err) {
      log.error({ err }, 'persist turn messages failed');
      await finishFailed('本轮回复未能保存（数据库异常），请重试。');
      return;
    }

    emitter.emit({ type: EventType.RUN_FINISHED, ...base });
    await emitter.flush();
  }

  return {
    async startTurn(input) {
      const sessionId = input.session.id;
      // 先占闸再落 user 消息：闸内串行，同会话并发请求只有一个能进来。
      if (active.has(sessionId)) return { status: 'busy' };
      const controller = new AbortController();
      active.set(sessionId, controller);

      let userMessage: MessageRecord;
      try {
        userMessage = await appendMessage(deps.db, {
          sessionId,
          role: 'user',
          content: [{ type: 'text', text: input.text }],
          status: 'completed',
        });
      } catch (err) {
        active.delete(sessionId);
        throw err;
      }

      void executeTurn({
        sessionId,
        definition: input.definition,
        text: input.text,
        userSeq: userMessage.seq,
        controller,
        log: input.log,
      })
        .catch((err) => input.log.error({ err }, 'turn crashed'))
        .finally(() => active.delete(sessionId));

      return { status: 'started', userMessage };
    },

    interrupt(sessionId) {
      const controller = active.get(sessionId);
      if (!controller) return false;
      controller.abort();
      return true;
    },

    isBusy(sessionId) {
      return active.has(sessionId);
    },
  };
}
