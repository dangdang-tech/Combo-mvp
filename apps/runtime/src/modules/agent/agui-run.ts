// 一个回合的 AG-UI 编排：与 run-turn 同骨架，但发标准 AG-UI 事件，产物走共享状态 STATE_DELTA。
//   RUN_STARTED → TEXT_MESSAGE_START/CONTENT*（中途可穿插 STATE_DELTA 产物）→ TEXT_MESSAGE_END → RUN_FINISHED；
//   失败发 RUN_ERROR（终态）。落库与自定义协议完全一致——AG-UI 只换线协议。
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { ArtifactRef, RunStage, RunStageStatus, TrialProcessState } from '@cb/shared';
import type { Env } from '../../platform/config/env.js';
import { createArtifactTool } from '../artifact/artifact-tool.js';
import { saveTurn, type SessionRow } from '../session/repo.js';
import type { AguiEmitter } from './agui-emitter.js';
import { buildAgent } from './build-agent.js';
import { hasLlmCredential } from './model.js';

export interface TurnLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface RunAguiInput {
  env: Env;
  pool: Pool;
  session: SessionRow;
  runId?: string | null;
  /** 已折叠结构化输入后的有效用户文本（取自 RunAgentInput 最新一条 user 消息）。 */
  userText: string;
  emitter: AguiEmitter;
  log: TurnLogger;
}

export type RunAguiResult = 'completed' | 'failed' | 'interrupted';

const TRIAL_STAGE_TEMPLATES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'read_experience', label: '读取经验体' },
  { key: 'cluster_persona', label: '聚类受众特征' },
  { key: 'verify_quotes', label: '校验引用真实性' },
  { key: 'layout_cards', label: '排版产物卡' },
];

/** RFC 6901 JSON Pointer 段转义（产物 key 可能含特殊字符）。 */
function ptr(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

function trialProcessState(index: number, status: RunStageStatus): TrialProcessState {
  const steps: RunStage[] = TRIAL_STAGE_TEMPLATES.map((stage, i) => ({
    ...stage,
    status: i < index ? 'completed' : i === index ? status : 'pending',
  }));
  return {
    steps,
    currentKey:
      status === 'completed' && index >= steps.length - 1 ? null : (steps[index]?.key ?? null),
  };
}

export async function runAgui(input: RunAguiInput): Promise<RunAguiResult> {
  const { env, pool, session, runId, userText, emitter, log } = input;

  emitter.runStarted();
  let currentStage = 0;
  const emitStage = (index: number, status: RunStageStatus): void => {
    currentStage = index;
    emitter.stateDelta([
      { op: 'add', path: '/trialProcess', value: trialProcessState(index, status) },
    ]);
  };
  emitStage(0, 'running');

  if (!hasLlmCredential(env)) {
    emitStage(currentStage, 'failed');
    emitter.runError(
      '试用服务未配置模型密钥（ANTHROPIC_API_KEY 或 OPENROUTER_API_KEY），暂时无法对话。',
    );
    await emitter.flush();
    emitter.end();
    return 'failed';
  }

  const userId = randomUUID();
  const assistantId = randomUUID();
  const collected: ArtifactRef[] = [];
  let textOpen = false;
  let assistantText = '';

  const closeTextIfOpen = (): void => {
    if (textOpen) {
      emitter.textEnd(assistantId);
      textOpen = false;
    }
  };

  const artifactTool = createArtifactTool({
    pool,
    sessionId: session.id,
    collected,
    // 产物 → 共享状态：add /artifacts/<key>（RFC 6902 'add' 对已存在成员即替换）+ 置 activeArtifactKey。
    onArtifact: (full) => {
      emitStage(3, 'running');
      emitter.stateDelta([
        { op: 'add', path: `/artifacts/${ptr(full.artifactKey)}`, value: full },
        { op: 'add', path: '/activeArtifactKey', value: full.artifactKey },
      ]);
      emitStage(3, 'completed');
    },
  });

  const agent = buildAgent({
    env,
    systemPrompt: session.instructions,
    transcript: session.transcript,
    tools: [artifactTool],
  });
  emitStage(1, 'running');

  emitter.signal.addEventListener('abort', () => agent.abort(), { once: true });

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta;
      if (!textOpen) {
        textOpen = true;
        emitter.textStart(assistantId);
      }
      assistantText += delta;
      emitter.textContent(assistantId, delta);
    }
  });

  try {
    await agent.prompt(userText);
  } catch (err) {
    unsubscribe();
    if (emitter.signal.aborted) {
      emitter.end();
      return 'interrupted';
    }
    log.error(err, 'runAgui: agent.prompt failed');
    closeTextIfOpen();
    emitStage(currentStage, 'failed');
    emitter.runError('对话生成失败，请重试。');
    await emitter.flush();
    emitter.end();
    return 'failed';
  }
  unsubscribe();

  // pi 把运行时失败编码进最终消息（stopReason='error'）而非抛错，显式探测。
  const msgs = agent.state.messages;
  const lastAssistant = [...msgs]
    .reverse()
    .find((m) => (m as { role?: string }).role === 'assistant') as
    | { stopReason?: string; errorMessage?: string }
    | undefined;
  if (lastAssistant?.stopReason === 'error' || agent.state.errorMessage != null) {
    log.error(
      { errorMessage: agent.state.errorMessage ?? lastAssistant?.errorMessage },
      'runAgui: LLM runtime failure (encoded in message)',
    );
    closeTextIfOpen();
    if (!emitter.signal.aborted) {
      emitStage(currentStage, 'failed');
      emitter.runError('模型调用失败（额度/网络/服务波动），请重试。');
      await emitter.flush();
      emitter.end();
    }
    return emitter.signal.aborted ? 'interrupted' : 'failed';
  }

  closeTextIfOpen();

  try {
    const transcript = agent.state.messages as unknown[];
    await saveTurn(pool, {
      sessionId: session.id,
      runId: runId ?? null,
      user: { id: userId, text: userText },
      assistant: { id: assistantId, text: assistantText, artifacts: collected },
      transcript,
    });
  } catch (err) {
    log.error(err, 'runAgui: saveTurn failed');
    emitStage(currentStage, 'failed');
    emitter.runError('本回合未能保存（数据库异常），请重试。');
    await emitter.flush();
    emitter.end();
    return 'failed';
  }

  emitStage(TRIAL_STAGE_TEMPLATES.length - 1, 'completed');
  emitter.runFinished();
  await emitter.flush();
  emitter.end();
  return 'completed';
}
