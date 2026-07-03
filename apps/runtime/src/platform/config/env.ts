// runtime 运行期 env 加载 + 校验（精简版，对齐 authoring 口径：production 缺关键连接串即启动失败；
//   dev/test 回落默认 + warn）。LLM key 不进必填集——缺失只让对话端点降级，不阻塞启动。
import { z } from 'zod';

/** 留空即默认：compose `X=${X:-}` 注入会把未设变量变成空串 ''，统一规整成 undefined 走 schema 语义。 */
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 试用端 api 进程默认 3100（避开 authoring 的 3000，两端可并行起）。
  PORT: z.coerce.number().int().default(3100),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Observability（OpenTelemetry）。默认不启用导出；配置 OTLP endpoint 后才向 Collector 发 traces。
  OTEL_SERVICE_NAME: z.string().default('cb-runtime'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  OTEL_RESOURCE_ATTRIBUTES: z.string().default(''),
  OTEL_TRACES_SAMPLER: z.string().default(''),
  OTEL_TRACES_SAMPLER_ARG: z.string().default(''),
  OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('false'),

  // 试用端只读已发布投影；默认连同一 Postgres（生产应给最小只读凭据，见 apps/runtime/README）。
  DATABASE_URL: z.string().default('postgres://agora:agora@localhost:5432/agora'),

  // LLM（pi 执行层）。缺 key → 对话端点降级报「未配置模型密钥」，不阻塞启动（对齐 authoring：LLM 不进必填集）。
  //   provider 留空则按 key 自动判定（有 OpenRouter key 而无 Anthropic key → openrouter，对齐 authoring）。
  RUNTIME_LLM_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(['anthropic', 'openrouter']).optional(),
  ),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENROUTER_API_KEY: z.string().default(''),
  // 显式模型 id 覆盖；空 → 代码按 provider 兜底已知 id（见 modules/agent/model.ts）。
  RUNTIME_LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('')),

  // 匿名身份 cookie（MVP）。CORS 允许来源（dev 走 vite 代理同源；留空 = 反射来源放开，生产收敛）。
  CORS_ORIGIN: z.string().default(''),

  // 创作者登录态（trial 路径）：复用 authoring 写入的 cb_session。runtime 只验证 token 并读 users，
  // 不 import authoring 代码、不负责登录回调。
  LOGTO_ISSUER: z.string().default('http://localhost:3001/oidc'),
  LOGTO_JWKS_URI: z.string().default('http://localhost:3001/oidc/jwks'),
  LOGTO_AUDIENCE: z.string().default(''),
  DEV_LOGIN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DEV_SESSION_SECRET: z.string().default(''),
});
export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** 解析进程 env（缓存）。production 缺 DATABASE_URL → 启动失败；dev/test 回落默认 + warn。 */
export function loadEnv(): Env {
  if (cached) return cached;
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    const url = process.env.DATABASE_URL;
    if (!url || url.trim() === '') {
      throw new Error('[env] 生产模式缺少 DATABASE_URL（不允许默认 fallback）。请显式设置后重启。');
    }
    const issuer = process.env.LOGTO_ISSUER;
    const audience = process.env.LOGTO_AUDIENCE;
    const jwks = process.env.LOGTO_JWKS_URI;
    if (
      !issuer ||
      issuer.trim() === '' ||
      !audience ||
      audience.trim() === '' ||
      !jwks ||
      jwks.trim() === ''
    ) {
      throw new Error(
        '[env] 生产模式缺少 LOGTO_ISSUER/LOGTO_JWKS_URI/LOGTO_AUDIENCE（trial 登录态验证不允许默认 fallback）。',
      );
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    if (isProd) {
      throw new Error(
        `[env] 生产环境变量校验失败：${Object.keys(parsed.error.flatten().fieldErrors).join(', ')}`,
      );
    }
    console.warn(
      '[env] 部分环境变量缺失/不合法，回落默认值（dev/test 守卫）：',
      parsed.error.flatten().fieldErrors,
    );
    cached = EnvSchema.parse({});
    return cached;
  }

  cached = parsed.data;
  if (isProd && cached.DEV_LOGIN_ENABLED) {
    console.warn('[env] 生产模式禁止 DEV_LOGIN_ENABLED=true：已强制关闭。');
    cached = { ...cached, DEV_LOGIN_ENABLED: false };
  }
  if (!isProd && (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '')) {
    console.warn('[env] dev/test 使用默认 DATABASE_URL（生产将拒绝启动）。');
  }
  return cached;
}
