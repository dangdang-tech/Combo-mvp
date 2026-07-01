// 健康检查（不在 /api/v1 前缀）。liveness 恒 ok；readiness 探 DB。
import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../../bootstrap/context.js';
import { pingDb } from '../infra/db.js';

export async function registerHealthRoutes(
  app: FastifyInstance,
  ctx: RuntimeContext,
): Promise<void> {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const db = await pingDb(ctx.env);
    return reply.code(db ? 200 : 503).send({ ok: db, db });
  });
}
