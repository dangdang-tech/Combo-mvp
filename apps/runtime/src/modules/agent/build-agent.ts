// pi Agent 的 TurnAgent 实现：CapabilityDefinition.instructions 组系统提示词 +
//   messages 表历史重建 pi AgentMessage[] 直接喂回 + 挂产物工具 + 定模型与密钥。
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { CapabilityDefinition } from '@cb/shared';
import type { Env } from '../../platform/config/env.js';
import {
  apiKeyFor,
  hasLlmCredential,
  resolveModel,
  type RuntimeModel,
} from '../../platform/infra/llm.js';
import type { MessageRecord } from '../session/repo.js';
import { TurnAgentUnavailableError, type TurnAgent, type TurnAgentFactory } from './run-turn.js';

/** 产物协议：约束模型「成品进产物、正文只放说明」。 */
const ARTIFACT_PROTOCOL = [
  '# 产物（Artifact）协议 —— 必须遵守',
  '当你要产出「可独立留存、用户会保存/复用/反复查看」的成品（一篇文档、一个网页、一段代码、一份结构化报告/清单/评分）时，',
  '必须调用 upsert_artifact 工具把成品写成产物，而不是把成品全文堆进聊天正文。',
  '',
  '- 聊天正文只放：简短说明、思路、给用户的提示与追问；成品本体进产物。',
  '- 修改已有产物：带上之前回执里的 artifactId（原地更新同一份产物）；新成品则省略 artifactId。',
  '- kind 选择：',
  '  - html：可交互/可视化网页，会被放进【沙箱 iframe】预览。必须产出【完整自包含 HTML 文档】',
  '    （含 <!doctype html>、<html>、内联 <style>/<script>）；可用公共 CDN，禁止外链需要鉴权的私有资源。',
  '  - markdown：富文本文档（报告/文章/说明）。',
  '  - code：单文件代码产物（用 language 标注语言，如 ts/python/sql）。',
  '  - structured：结构化数据产物（评分卡/清单/字段表），content 用 JSON 字符串。',
  '- 产出后用一两句话说明你做了什么、可以怎么用，并主动邀请用户继续迭代；不要在正文重复产物全文。',
].join('\n');

/** 编排完整 systemPrompt：作者 instructions 逐字 + 平台注入的运行约定。 */
export function composeSystemPrompt(definition: CapabilityDefinition): string {
  return [
    definition.instructions.trim(),
    '',
    '———',
    '以下为平台注入的运行约定（请严格遵守）：',
    '',
    '# 这个能力',
    `名称：${definition.name}`,
    `简介：${definition.summary}`,
    '',
    ARTIFACT_PROTOCOL,
  ].join('\n');
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * messages 行 → pi AgentMessage[]（喂回 agent 重建上下文）。
 *   content 块原样回放（写入时已过 schema 校验）；assistant 的 api/provider/usage 等
 *   元数据不落库，用当前模型 + 零 usage 补齐——convertToLlm 只消费 role/content，无损。
 */
export function historyToAgentMessages(rows: MessageRecord[], model: RuntimeModel): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const row of rows) {
    const timestamp = Date.parse(row.createdAt) || Date.now();
    if (row.role === 'user') {
      const message: UserMessage = {
        role: 'user',
        content: row.content as UserMessage['content'] & unknown[],
        timestamp,
      };
      out.push(message);
    } else if (row.role === 'assistant') {
      const content = row.content as AssistantMessage['content'];
      const message: AssistantMessage = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp,
      };
      out.push(message);
    } else {
      // role='tool' 行：单元素 toolResult 包装块 → pi ToolResultMessage（配对信息在块内）。
      for (const block of row.content as Array<{
        toolCallId: string;
        toolName: string;
        content: ToolResultMessage['content'];
        isError: boolean;
      }>) {
        const message: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          content: block.content,
          isError: block.isError,
          timestamp,
        };
        out.push(message);
      }
    }
  }
  return out;
}

/** 生产 TurnAgentFactory：pi Agent 包装成 run-turn 消费的最小面。 */
export function createPiTurnAgentFactory(env: Env): TurnAgentFactory {
  return ({ definition, history, tools }) => {
    if (!hasLlmCredential(env)) {
      throw new TurnAgentUnavailableError(
        '试用服务未配置模型密钥（ANTHROPIC_API_KEY 或 OPENROUTER_API_KEY），暂时无法对话。',
      );
    }
    const model = resolveModel(env);
    const agent = new Agent({
      initialState: {
        systemPrompt: composeSystemPrompt(definition),
        model,
        tools,
        messages: historyToAgentMessages(history, model),
        thinkingLevel: 'off',
      },
      // 按 model.provider 注入对应 key（anthropic→ANTHROPIC_API_KEY / openrouter→OPENROUTER_API_KEY）。
      getApiKey: (provider) => apiKeyFor(env, provider),
    });

    return {
      subscribeTextDelta(fn) {
        return agent.subscribe((event: AgentEvent) => {
          if (
            event.type === 'message_update' &&
            event.assistantMessageEvent.type === 'text_delta'
          ) {
            fn(event.assistantMessageEvent.delta);
          }
        });
      },
      prompt: (text) => agent.prompt(text),
      abort: () => agent.abort(),
      transcript: () => agent.state.messages as unknown[],
      runtimeError: () => {
        const stateError = (agent.state as { errorMessage?: string | null }).errorMessage;
        if (stateError != null) return stateError;
        const last = [...agent.state.messages]
          .reverse()
          .find((m) => (m as { role?: string }).role === 'assistant') as
          | { stopReason?: string; errorMessage?: string }
          | undefined;
        if (last?.stopReason === 'error') return last.errorMessage ?? 'llm runtime error';
        return undefined;
      },
    } satisfies TurnAgent;
  };
}
