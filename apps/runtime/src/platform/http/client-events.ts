import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTraceId } from '@cb/shared';
import { currentTraceLogFields } from '../observability/node.js';

const ClientEventSchema = z.object({
  kind: z.enum(['api_error', 'sse_error', 'window_error', 'unhandled_rejection']),
  traceId: z.string().optional(),
  message: z.string().max(1000).optional(),
  stack: z.string().max(4000).optional(),
  url: z.string().max(1000).optional(),
  route: z.string().max(300).optional(),
  source: z.string().max(80).optional(),
});

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export async function registerClientEventRoutes(app: FastifyInstance): Promise<void> {
  app.post('/client-events', async (req, reply) => {
    const parsed = ClientEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      req.log.warn(
        { ...currentTraceLogFields(req.id), reason: 'invalid_client_event' },
        'client observability event rejected',
      );
      return reply.code(204).send();
    }

    const eventTraceId = normalizeTraceId(parsed.data.traceId) ?? req.id;
    req.log.warn(
      {
        ...currentTraceLogFields(eventTraceId),
        clientEvent: {
          kind: parsed.data.kind,
          source: parsed.data.source ?? 'runtime-web',
          route: truncate(parsed.data.route, 300),
          url: truncate(parsed.data.url, 1000),
          message: truncate(parsed.data.message, 1000),
          stack: truncate(parsed.data.stack, 4000),
        },
      },
      'client observability event',
    );
    return reply.code(204).send();
  });
}
