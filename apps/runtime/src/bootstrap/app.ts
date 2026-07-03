// Fastify app 工厂（试用端）。精简：CORS + Cookie + 统一错误信封 + 健康检查 + 业务路由。
//   绝不裸露错误码（统一 ErrorEnvelope，复用 @cb/shared 脊柱）。无 Logto/幂等/队列（试用端不需要）。
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import {
  API_PREFIX,
  buildErrorWithCode,
  ErrorCode,
  httpStatusFor,
  newTraceId,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  traceIdFromHeaders,
  traceIdFromUrl,
  type ErrorCodeValue,
} from '@cb/shared';
import { loadEnv, type Env } from '../platform/config/env.js';
import { getPool } from '../platform/infra/db.js';
import { registerHealthRoutes } from '../platform/http/health.js';
import { registerCapabilityRoutes } from '../modules/capability/routes.js';
import { registerSessionRoutes } from '../modules/session/routes.js';
import type { RuntimeContext } from './context.js';
import {
  currentTraceId,
  currentTraceLogFields,
  currentTraceparent,
} from '../platform/observability/node.js';
import { registerClientEventRoutes } from '../platform/http/client-events.js';

export interface BuildAppOptions {
  env?: Env;
}

function resolveRequestTraceId(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string {
  return traceIdFromHeaders(headers) ?? traceIdFromUrl(url) ?? currentTraceId() ?? newTraceId();
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv();
  const app = Fastify({
    bodyLimit: 4 * 1024 * 1024,
    logger: {
      level: env.LOG_LEVEL,
      base: { service: env.OTEL_SERVICE_NAME, process: 'runtime-api' },
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
      formatters: { log: (obj) => obj },
    },
    genReqId: (req) => resolveRequestTraceId(req.headers, req.url),
    trustProxy: true,
  });

  const ctx: RuntimeContext = { env, pool: getPool(env) };

  await app.register(cors, {
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,
    credentials: true,
  });
  await app.register(cookie);

  app.addHook('onRequest', async (req, reply) => {
    reply.header(TRACE_ID_HEADER, req.id);
    reply.header(TRACEPARENT_HEADER, currentTraceparent(req.id));
  });

  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        ...currentTraceLogFields(req.id),
        method: req.method,
        url: req.url,
        route: req.routeOptions.url ?? req.url,
        statusCode: reply.statusCode,
      },
      'request completed',
    );
  });

  // 统一错误信封（对外无 code/堆栈；内部 code + err 进结构化日志，经 traceId 关联）。
  app.setErrorHandler((err, req, reply) => {
    let code: ErrorCodeValue = ErrorCode.INTERNAL;
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) code = ErrorCode.RATE_LIMITED;
    else if ((err as { validation?: unknown }).validation || statusCode === 400)
      code = ErrorCode.VALIDATION_FAILED;
    const { code: internalCode, envelope } = buildErrorWithCode(code, req.id);
    req.log.error({ err, code: internalCode, ...currentTraceLogFields(req.id) }, 'request failed');
    reply.code(httpStatusFor(code)).send(envelope);
  });

  app.setNotFoundHandler((req, reply) => {
    const { code, envelope } = buildErrorWithCode(ErrorCode.NOT_FOUND, req.id);
    req.log.warn({ code, ...currentTraceLogFields(req.id) }, 'route not found');
    reply.code(httpStatusFor(ErrorCode.NOT_FOUND)).send(envelope);
  });

  // 健康检查（不在 /api/v1 前缀）。
  await registerHealthRoutes(app, ctx);

  // 业务路由（/api/v1/runtime/*）。
  await app.register(
    async (scoped) => {
      await registerClientEventRoutes(scoped);
      await registerCapabilityRoutes(scoped, ctx);
      await registerSessionRoutes(scoped, ctx);
    },
    { prefix: API_PREFIX },
  );

  app.addHook('onClose', async () => {
    const { closeDb } = await import('../platform/infra/db.js');
    await closeDb();
  });

  return app;
}
