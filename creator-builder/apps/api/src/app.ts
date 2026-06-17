// Fastify app 工厂（骨架）。挂基础设施容器 + 全局插件 + 统一错误信封 + 健康检查 + 业务路由（501 占位）。
// 三条硬规则在 api 层入口：绝不裸露错误码（统一 ErrorEnvelope，脊柱 §3/§11.B）。
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import {
  API_PREFIX,
  buildErrorWithCode,
  ErrorCode,
  httpStatusFor,
  type ErrorCodeValue,
} from '@cb/shared';
import { loadEnv, type Env } from './config/env.js';
import { buildInfra } from './infra/index.js';
import { persistIdempotencyResponse } from './middleware/idempotency.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerBusinessRoutes } from './routes/index.js';
import { registerDevAuthRoutes } from './routes/auth.js';
import { devLoginAvailable } from './infra/dev-session.js';
// 副作用导入：注册 Fastify 类型增强（req.auth / app.infra 等）。
import './types/fastify.js';

/** 生成 traceId（骨架：用 crypto.randomUUID；生产换 UUID v7/ULID，脊柱 §3.4）。 */
function newTraceId(): string {
  return crypto.randomUUID();
}

export interface BuildAppOptions {
  /** 覆盖 env（测试用）。 */
  env?: Env;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv();
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
      // 结构化日志按 traceId（脊柱 §3.4：贯穿日志/Sentry/outbox/SSE）。
      formatters: {
        log: (obj) => obj,
      },
    },
    genReqId: () => newTraceId(),
    disableRequestLogging: false,
    // 反代后取真实 IP（限流/日志用）。
    trustProxy: true,
  });

  // —— 基础设施容器：注入 app.infra（db/redis/queue/objectStore/llm），handler 经 req.server.infra 取用 ——
  app.decorate('infra', buildInfra(env));

  // —— 全局插件 ——
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: true }); // 同源 Cookie 会话需 credentials
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false, // 默认不全局限流；各写端点 Phase 3 按 scope 挂（脊柱 §3.3 RATE_LIMITED）
    max: 100,
    timeWindow: '1 minute',
  });
  await app.register(multipart, {
    limits: { fileSize: 200 * 1024 * 1024 }, // 本机助手分片直传（B-21）
  });

  // 把每请求 traceId 暴露在 reply 头（前端「反馈代码」用，脊柱 §3.4）+ 进日志上下文。
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-trace-id', req.id);
  });

  // 幂等响应落库（脊柱 §4.2，Codex#6）：全局注册【一次】onSend，对本次取得租约的写命令
  //   落 response_ref（2xx→completed 供回放 / 非 2xx→failed 允许重试）。绝不每请求 addHook（防泄漏）。
  //   SSE 流已 reply.hijack()，不进 onSend；只对常规 HTTP 写命令生效。
  app.addHook('onSend', async (req, reply, payload) => {
    await persistIdempotencyResponse(req, reply.statusCode, payload);
    return payload;
  });

  // —— 统一错误信封（脊柱 §3 / §11.B / D1：绝不裸露错误码/堆栈/原始报错）——
  //   对外只发 envelope（无 code、无原始 message/stack/SQL）；内部 code + 原始 err 进结构化日志，
  //   经 traceId 关联（运维据 reply 头 x-trace-id 在日志查 code/堆栈）。
  app.setErrorHandler((err, req, reply) => {
    const traceId = req.id;

    // 未知/内部异常一律映射为安全通用 code（默认 INTERNAL）。
    // 限流 → RATE_LIMITED；校验/序列化错误 / 400 → VALIDATION_FAILED；其余 → INTERNAL。
    // 具体业务 code 由各 handler 自行 buildError 返回（不经此兜底）。
    let code: ErrorCodeValue = ErrorCode.INTERNAL;
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      code = ErrorCode.RATE_LIMITED;
    } else if ((err as { validation?: unknown }).validation || statusCode === 400) {
      code = ErrorCode.VALIDATION_FAILED;
    }

    // 内部错误对：envelope（对外，无 code）+ code（仅日志）。
    const { code: internalCode, envelope } = buildErrorWithCode(code, traceId);
    // 内部记完整 err（含堆栈/原始报错）+ 内部 code + traceId（D1 关联），对外绝不出这些。
    req.log.error({ err, code: internalCode, traceId }, 'request failed');
    reply.code(httpStatusFor(code)).send(envelope);
  });

  // —— 404 也走信封（不裸露路由信息）——
  app.setNotFoundHandler((req, reply) => {
    const { code, envelope } = buildErrorWithCode(ErrorCode.NOT_FOUND, req.id);
    req.log.warn({ code, traceId: req.id }, 'route not found');
    reply.code(httpStatusFor(ErrorCode.NOT_FOUND)).send(envelope);
  });

  // 健康检查（脊柱 §10，不在 /api/v1 前缀）。
  await registerHealthRoutes(app);

  // 业务路由（Phase 3 实现，本期 501 占位，但路径/方法/前缀/鉴权/幂等标注真实可调）。
  await registerBusinessRoutes(app);

  // —— 仅 dev/test 种子登录（安全双守卫，绝不上生产）——
  //   仅当 devLoginAvailable（NODE_ENV≠prod 且 DEV_LOGIN_ENABLED=true 且有 DEV_SESSION_SECRET）才注册
  //   POST /api/v1/auth/dev-login；生产/开关关 → 端点【根本不存在】（命中走 setNotFoundHandler → 404）。
  if (devLoginAvailable(env)) {
    await app.register(
      async (scoped) => {
        await registerDevAuthRoutes(scoped);
      },
      { prefix: API_PREFIX },
    );
    app.log.warn('[dev-login] 已启用种子登录端点 POST /api/v1/auth/dev-login（仅 dev/test）');
  }

  // 进程退出时关闭基础设施连接（onClose 钩子）。
  app.addHook('onClose', async () => {
    const { closeDb, closeRedis, closeQueues, closeObjectStore } = await import('./infra/index.js');
    await Promise.allSettled([closeDb(), closeRedis(), closeQueues()]);
    closeObjectStore();
  });

  return app;
}
