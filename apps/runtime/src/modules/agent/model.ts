// LLM 模型与凭据解析（pi-ai 内置注册表）。0.80.2 口径：从 providers/all 子路径取内置模型对象（纯对象）。
//   双 provider：anthropic 直连，或 openrouter（OpenAI 兼容，与本仓 authoring 同口径）。
//   provider 留空则按 key 自动判定；模型 id 可经 RUNTIME_LLM_MODEL 覆盖。
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { Env } from '../../platform/config/env.js';

export type LlmProvider = 'anthropic' | 'openrouter';

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openrouter: 'anthropic/claude-sonnet-4.6',
};

/** provider 解析：显式优先；否则按 key 自动判定（有 OpenRouter key 而无 Anthropic key → openrouter）。 */
export function resolveProvider(env: Env): LlmProvider {
  if (env.RUNTIME_LLM_PROVIDER) return env.RUNTIME_LLM_PROVIDER;
  if (env.OPENROUTER_API_KEY && !env.ANTHROPIC_API_KEY) return 'openrouter';
  return 'anthropic';
}

/** 取某 provider 的 API key（空 → undefined）。pi getApiKey 据此按 model.provider 注入。 */
export function apiKeyFor(env: Env, provider: string): string | undefined {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY || undefined;
  if (provider === 'openrouter') return env.OPENROUTER_API_KEY || undefined;
  return undefined;
}

/** 当前配置是否具备可用 LLM 凭据（对话端点据此决定是否降级）。 */
export function hasLlmCredential(env: Env): boolean {
  return Boolean(apiKeyFor(env, resolveProvider(env)));
}

export function resolveModel(env: Env) {
  const provider = resolveProvider(env);
  const wanted = env.RUNTIME_LLM_MODEL || DEFAULT_MODEL[provider];
  const models = getBuiltinModels(provider);
  const found =
    models.find((m) => m.id === wanted) ?? models.find((m) => m.id === DEFAULT_MODEL[provider]);
  if (!found) {
    throw new Error(`[model] 没有可用的 ${provider} 内置模型（wanted=${wanted}）`);
  }
  return found;
}

export type RuntimeModel = ReturnType<typeof resolveModel>;
