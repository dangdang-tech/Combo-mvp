// 运行期 env 加载 + 校验（对齐 authoring 口径）：
//   生产缺关键连接串/密钥即启动失败；dev/test 回落默认 + warn。
//   LLM key 不进生产必填集——缺失只让对话轮次降级报错，不阻塞启动。
import { z } from 'zod';

/** 「留空即默认」：compose `X=${X:-}` 注入会把未设变量变成空串 ''，统一规整成 undefined 走 schema 语义。 */
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
  OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('false'),

  // PostgreSQL：与创作端同一个库（capabilities 只读 + 试用层四表读写）。
  DATABASE_URL: z.string().default('postgres://combo:combo@localhost:5432/combo'),

  // ObjectStore（MinIO/S3）：按 capabilities.storage_key 读能力定义 + 读写产物内容。
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_REGION: z.string().default('us-east-1'),

  // 登录态验证：复用 authoring 写入的 cb_session Cookie（Logto access_token）。
  // runtime 只验签 + 查 users，不做 OIDC 回调、不建用户。
  LOGTO_ISSUER: z.string().default('http://localhost:3001/oidc'),
  LOGTO_JWKS_URI: z.string().default('http://localhost:3001/oidc/jwks'),
  // 生产必填且无条件校 aud；dev/test 配了才校。
  LOGTO_AUDIENCE: z.string().default(''),

  // LLM（pi 执行层）。provider 留空按 key 自动判定；缺 key → 对话轮次报「未配置模型密钥」。
  RUNTIME_LLM_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(['anthropic', 'openrouter']).optional(),
  ),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENROUTER_API_KEY: z.string().default(''),
  // 显式模型 id 覆盖；空 → 按 provider 兜底（见 platform/infra/llm.ts）。
  RUNTIME_LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('')),
  // 轮次空闲看门狗：LLM 流两次活动间隔超过此值（毫秒）判连接夯死，abort 本轮并发 RUN_ERROR。
  // 只判无输出的停滞，不限制轮次总时长（issue #51）。
  RUNTIME_TURN_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),

  // CORS 允许来源（dev 走 vite 代理同源；留空 = 反射来源放开，生产收敛）。
  CORS_ORIGIN: z.string().default(''),

  // dev 种子登录验证分支（与 authoring 同一把 HS256 密钥；runtime 只验不签）。
  // 双守卫：NODE_ENV !== 'production' 且 DEV_LOGIN_ENABLED=true；生产无条件强制关闭。
  DEV_LOGIN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DEV_SESSION_SECRET: z.string().default(''),
});
export type Env = z.infer<typeof EnvSchema>;

/** 生产必填（缺失即启动 throw，绝不带默认凭据上生产）。LLM key 不在列。 */
const PRODUCTION_REQUIRED = [
  'DATABASE_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'LOGTO_ISSUER',
  'LOGTO_JWKS_URI',
  'LOGTO_AUDIENCE',
] as const;

let cached: Env | undefined;

/** 解析进程 env（缓存）。production 缺必填 → throw；dev/test 回落默认 + warn。 */
export function loadEnv(): Env {
  if (cached) return cached;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    const missing = PRODUCTION_REQUIRED.filter((k) => {
      const v = process.env[k];
      return v === undefined || v.trim() === '';
    });
    if (missing.length > 0) {
      // 只打印缺失的 key 名，绝不打印值。
      throw new Error(
        `[env] 生产模式缺少必需配置（不允许默认 fallback）：${missing.join(', ')}。请显式设置后重启。`,
      );
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    if (isProduction) {
      throw new Error(
        `[env] 生产模式环境变量校验失败：${Object.keys(parsed.error.flatten().fieldErrors).join(', ')}`,
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

  // 生产无条件强制关闭 dev 登录验证分支（即便误配 true）。
  if (isProduction && cached.DEV_LOGIN_ENABLED) {
    console.warn('[env] 生产模式禁止 DEV_LOGIN_ENABLED=true：已强制关闭。');
    cached = { ...cached, DEV_LOGIN_ENABLED: false };
  }

  if (!isProduction) {
    const usingDefaults = PRODUCTION_REQUIRED.filter((k) => {
      const v = process.env[k];
      return v === undefined || v.trim() === '';
    });
    if (usingDefaults.length > 0) {
      console.warn(`[env] dev/test 使用默认值（生产将拒绝启动）：${usingDefaults.join(', ')}`);
    }
  }

  return cached;
}
