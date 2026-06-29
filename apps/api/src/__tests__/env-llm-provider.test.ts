// env.ts LLM「留空即默认」预处理自检（P1-1，反向破坏可测）：
//   compose 用 `LLM_PROVIDER=${LLM_PROVIDER:-}` 注入时，未设的变量是空串 '' 而非 undefined。
//   空串对 z.enum(...).optional() 是非法值 → 生产 loadEnv 解析失败/启动失败，违背「留空按 key 自动判定」。
//   预处理把空串规整成 undefined → 走 .optional()/.default()，从而：
//     - LLM_PROVIDER='' + 有 OPENROUTER_API_KEY → 不抛、自动判定 openrouter；
//     - 全空 → 不抛、走 anthropic 默认路径（无 key → degraded）；
//     - 显式 anthropic/openrouter 正常；非法值仍报错（生产 throw）；
//     - LLM_BASE_URL='' → 不被空串覆盖、回落默认基址（否则 OpenRouter URL 拼空崩）。
// 每例 vi.resetModules() 拿全新 loadEnv 缓存（cached），并隔离 process.env。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SNAPSHOT = { ...process.env };

beforeEach(() => {
  vi.resetModules(); // 清模块缓存 → loadEnv 的 cached 重置
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SNAPSHOT)) delete process.env[k];
  }
  Object.assign(process.env, SNAPSHOT);
});

/** 生产模式必须的非 LLM 密钥（避免 loadEnv 因缺这些 throw，聚焦 LLM 预处理本身）。 */
function setProductionRequiredEnv(): void {
  process.env.NODE_ENV = 'production';
  process.env.PROCESS = 'api';
  process.env.DATABASE_URL = 'postgres://u:p@db:5432/x';
  process.env.REDIS_QUEUE_URL = 'redis://r:6379/0';
  process.env.REDIS_HOT_URL = 'redis://r:6380/0';
  process.env.S3_ENDPOINT = 'http://s3:9000';
  process.env.S3_ACCESS_KEY = 'k';
  process.env.S3_SECRET_KEY = 's';
  process.env.LOGTO_ENDPOINT = 'http://logto:3001';
  process.env.LOGTO_ISSUER = 'http://logto:3001/oidc';
  process.env.LOGTO_JWKS_URI = 'http://logto:3001/oidc/jwks';
  process.env.LOGTO_APP_ID = 'app';
  process.env.LOGTO_APP_SECRET = 'secret';
  process.env.LOGTO_REDIRECT_URI = 'http://x/api/v1/auth/callback';
  process.env.LOGTO_AUDIENCE = 'aud';
}

/** 清掉残留的 LLM env（保证每例从干净状态出发）。 */
function clearLlmEnv(): void {
  delete process.env.LLM_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
}

describe('env LLM「留空即默认」预处理（P1-1：空串 → undefined）', () => {
  it('生产：LLM_PROVIDER="" + OPENROUTER_API_KEY → 不抛，自动判定 openrouter', async () => {
    setProductionRequiredEnv();
    clearLlmEnv();
    process.env.LLM_PROVIDER = ''; // compose 注入的空串（反向破坏：去掉 preprocess，此处转红/抛）
    process.env.OPENROUTER_API_KEY = 'sk-or-xxx';
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv(); // 不应抛
    expect(env.LLM_PROVIDER).toBeUndefined(); // 空串被规整成 undefined（走自动判定）

    const { resolveLlmProvider } = await import('../infra/llm/index.js');
    const r = resolveLlmProvider(env);
    expect(r.provider).toBe('openrouter'); // 有 OPENROUTER key 而无 ANTHROPIC key → 自动 openrouter
    expect(r.sdk).not.toBeNull();
  });

  it('生产：所有 LLM 变量为空串 → 不抛，走 anthropic 默认路径（无 key → degraded）', async () => {
    setProductionRequiredEnv();
    clearLlmEnv();
    process.env.LLM_PROVIDER = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.OPENROUTER_API_KEY = '';
    process.env.LLM_BASE_URL = '';
    process.env.LLM_MODEL = '';
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv(); // 不应抛
    expect(env.LLM_PROVIDER).toBeUndefined();
    // LLM_BASE_URL 空串被规整成 undefined → 回落默认基址（不被 '' 覆盖）。
    expect(env.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');

    const { resolveLlmProvider, probeLlm } = await import('../infra/llm/index.js');
    const r = resolveLlmProvider(env);
    expect(r.provider).toBe('anthropic'); // 无任何 key → 默认 anthropic 路径
    expect(r.sdk).toBeNull(); // 无 key → sdk=null（degraded 兜底）
    expect(probeLlm(env)).toBe('degraded'); // 全空 → degraded，不阻塞启动
  });

  it('生产：LLM_PROVIDER="anthropic" 显式 → 正常解析为 anthropic', async () => {
    setProductionRequiredEnv();
    clearLlmEnv();
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv();
    expect(env.LLM_PROVIDER).toBe('anthropic');
  });

  it('生产：LLM_PROVIDER="openrouter" 显式 → 正常解析为 openrouter', async () => {
    setProductionRequiredEnv();
    clearLlmEnv();
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-xxx';
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv();
    expect(env.LLM_PROVIDER).toBe('openrouter');
  });

  it('生产：LLM_PROVIDER 非法值（非空、非枚举）→ 仍抛（不被预处理放行）', async () => {
    setProductionRequiredEnv();
    clearLlmEnv();
    process.env.LLM_PROVIDER = 'bogus-provider'; // 非空非法值
    const { loadEnv } = await import('../config/env.js');
    expect(() => loadEnv()).toThrow(); // 生产校验失败 → throw（只非空非法才抛，空串不抛）
  });

  it('生产：LLM_BASE_URL="" 不覆盖默认基址（防 OpenRouter URL 拼空）', async () => {
    setProductionRequiredEnv();
    clearLlmEnv();
    process.env.LLM_BASE_URL = '';
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv();
    expect(env.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
});
