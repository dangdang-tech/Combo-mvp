// 健康检查路由。不在 /api/v1 前缀（基础设施探针口径）。
//   GET /health：进程活着（liveness），轻量、不查依赖。
//   GET /ready ：依赖就绪（readiness），查 db/minio/logto 三 required + llm（degraded 不算失败）。
//   runtime 无 Redis 依赖（单进程，事件订阅走进程内总线），故不探 redis_*。
import type { FastifyInstance } from 'fastify';
import {
  HEALTH_PATH,
  READY_PATH,
  type DependencyHealth,
  type HealthStatus,
  type ReadyView,
} from '@cb/shared';
import { pingDb } from '../infra/db.js';
import { pingObjectStore } from '../infra/object-store.js';
import { probeLogto } from '../infra/logto.js';
import { hasLlmCredential } from '../infra/llm.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(HEALTH_PATH, async () => ({ status: 'ok' as const }));

  app.get(READY_PATH, async (req, reply) => {
    const { env } = app.infra;
    const [db, minio, logto] = await Promise.all([
      pingDb(env),
      pingObjectStore(env),
      probeLogto(env),
    ]);
    const llm: HealthStatus = hasLlmCredential(env) ? 'ok' : 'degraded';

    const toStatus = (up: boolean): HealthStatus => (up ? 'ok' : 'down');
    const dependencies: DependencyHealth[] = [
      { name: 'db', status: toStatus(db), required: true },
      { name: 'minio', status: toStatus(minio), required: true },
      { name: 'logto', status: toStatus(logto), required: true },
      { name: 'llm', status: llm, required: false },
    ];

    const anyRequiredDown = dependencies.some((d) => d.required && d.status === 'down');
    const status: HealthStatus = anyRequiredDown ? 'down' : llm === 'degraded' ? 'degraded' : 'ok';
    const view: ReadyView = { status, ready: !anyRequiredDown, dependencies };

    // 必须 return reply（async handler 已 send，不 return 会触发二次 writeHead）。
    return reply.code(view.ready ? 200 : 503).send({ data: view, meta: { traceId: req.id } });
  });
}
