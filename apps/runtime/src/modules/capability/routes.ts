// 能力路由：试用市集列表 + 单能力公开视图（instructions 不下发，只在开会话时服务端注入）。
import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../../bootstrap/context.js';
import { notFound } from '../../platform/http/errors.js';
import { listPublishedCapabilities } from './list.js';
import { CapabilityLoadError, getPublishedCapability } from './loader.js';

export async function registerCapabilityRoutes(
  app: FastifyInstance,
  ctx: RuntimeContext,
): Promise<void> {
  // GET /runtime/capabilities — 试用市集列表
  app.get('/runtime/capabilities', async (_req, reply) => {
    const items = await listPublishedCapabilities(ctx.pool);
    return reply.send({ items });
  });

  // GET /runtime/capabilities/:slugOrId — 单能力公开视图（渲染输入表单/引导提示）
  app.get<{ Params: { slugOrId: string } }>(
    '/runtime/capabilities/:slugOrId',
    async (req, reply) => {
      try {
        const loaded = await getPublishedCapability(ctx.pool, req.params.slugOrId);
        if (!loaded) return notFound(reply, req.id);
        return reply.send(loaded.publicView);
      } catch (err) {
        if (err instanceof CapabilityLoadError) {
          req.log.warn({ reason: err.reason }, 'capability load rejected');
          return notFound(reply, req.id);
        }
        throw err;
      }
    },
  );
}
