// 构造一个 pi Agent：注入 systemPrompt（= 能力 instructions 编排）、rehydrate 历史转录、挂会话级工具、定模型与密钥。
//   契约消费链路的落点：agent.state.systemPrompt 即注入处；transcript 经 initialState.messages 重建上下文。
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Env } from '../../platform/config/env.js';
import type { ArtifactTool } from '../artifact/artifact-tool.js';
import { apiKeyFor, resolveModel } from './model.js';

export interface BuildAgentInput {
  env: Env;
  /** 注入的系统提示词（会话开始时冻结的 instructions 编排）。 */
  systemPrompt: string;
  /** 历史 pi 转录（AgentMessage[]，plain JSON）；首回合为 []。 */
  transcript: unknown[];
  /** 会话级工具（artifact 工具等）。 */
  tools: ArtifactTool[];
}

export function buildAgent(input: BuildAgentInput): Agent {
  const model = resolveModel(input.env);
  // transcript 是 pi 自己产出的 AgentMessage[]（plain JSON 往返安全），直接作为初始 messages 重建上下文。
  const messages = input.transcript as AgentMessage[];

  return new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      tools: input.tools,
      messages,
      thinkingLevel: 'off',
    },
    // 按 model.provider 注入对应 key（anthropic→ANTHROPIC_API_KEY / openrouter→OPENROUTER_API_KEY）。
    getApiKey: (provider) => apiKeyFor(input.env, provider),
  });
}
