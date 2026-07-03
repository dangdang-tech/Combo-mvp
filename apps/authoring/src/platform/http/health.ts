// 健康检查路由（脊柱 §10）。不在 /api/v1 前缀（基础设施探针口径）。
//   GET /health：进程活着（liveness），轻量、不查依赖。
//   GET /ready ：依赖就绪（readiness），查五 required（db/redis_queue/redis_hot/minio/logto）+ llm（degraded 不算失败）。
//     任一 required down → ready=false、503；llm degraded → status='degraded' 但 ready=true（脊柱 §10.2）。
import type { FastifyInstance } from 'fastify';
import {
  HEALTH_PATH,
  READY_PATH,
  type DependencyHealth,
  type HealthStatus,
  type ReadyView,
} from '@cb/shared';
import { pingDb } from '../infra/db.js';
import { pingRedis } from '../infra/redis.js';
import { pingObjectStore } from '../infra/object-store.js';
import { probeLogto } from '../infra/logto.js';
import { probeLlm } from '../infra/llm-gateway.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(HEALTH_PATH, async () => ({ status: 'ok' as const }));

  app.get(READY_PATH, async (req, reply) => {
    const { infra } = app;
    // 五 required 依赖真失败 + llm degraded（脊柱 §10.2）。并发探针、各自超时容错（探针内 catch → false）。
    const [db, redisQueue, redisHot, minio, logto] = await Promise.all([
      pingDb(infra.env),
      pingRedis(infra.redisQueue),
      pingRedis(infra.redisHot),
      pingObjectStore(infra.env),
      probeLogto(infra.env),
    ]);
    // 传 infra.env：probeLlm 据此解析 provider/key 判定 ok/degraded。不传 env 会恒 degraded（观测失真）。
    const llm = probeLlm(infra.env); // 'ok' | 'degraded' | 'down'（required:false，不计入 ready）

    const toStatus = (up: boolean): HealthStatus => (up ? 'ok' : 'down');
    const dependencies: DependencyHealth[] = [
      { name: 'db', status: toStatus(db), required: true },
      { name: 'redis_queue', status: toStatus(redisQueue), required: true },
      { name: 'redis_hot', status: toStatus(redisHot), required: true },
      { name: 'minio', status: toStatus(minio), required: true },
      { name: 'logto', status: toStatus(logto), required: true },
      { name: 'llm', status: llm, required: false },
    ];

    const anyRequiredDown = dependencies.some((d) => d.required && d.status === 'down');
    const llmDegraded = llm === 'degraded';
    const status: HealthStatus = anyRequiredDown ? 'down' : llmDegraded ? 'degraded' : 'ok';
    const view: ReadyView = { status, ready: !anyRequiredDown, dependencies };

    // 必须 return reply（async handler 已 send；不 return 会触发 onSend 后二次 writeHead，脊柱 §10 / Fastify lifecycle）。
    return reply.code(view.ready ? 200 : 503).send({ data: view, meta: { traceId: req.id } });
  });
}
