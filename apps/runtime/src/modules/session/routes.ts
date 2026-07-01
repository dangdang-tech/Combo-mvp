// 会话路由：开会话（冻结 instructions + manifestHash 快照）/ 列表 / 详情 / 发消息（AG-UI 流式回合）。
import type { FastifyInstance } from 'fastify';
import { RunAgentInputSchema } from '@ag-ui/core';
import { CreateSessionBodySchema, type SessionDetail } from '@cb/shared';
import type { RuntimeContext } from '../../bootstrap/context.js';
import { badRequest, notFound } from '../../platform/http/errors.js';
import { resolveOwnerId } from '../../platform/http/identity.js';
import { startAguiStream } from '../agent/agui-emitter.js';
import { runAgui } from '../agent/agui-run.js';
import { composeSystemPrompt } from '../agent/compose-prompt.js';
import { getPublishedCapability } from '../capability/loader.js';
import { getArtifacts } from '../artifact/repo.js';
import {
  createSession,
  getMessages,
  getSessionRow,
  listSessions,
} from './repo.js';

/** 从 AG-UI RunAgentInput.messages 取最新一条 user 消息的文本（服务端只认这条做新输入，其余以本地转录为真源）。 */
function latestUserText(messages: ReadonlyArray<{ role: string; content?: unknown }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c.trim() || null;
    if (Array.isArray(c)) {
      const text = c
        .map((p) =>
          p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
        )
        .join('');
      return text.trim() || null;
    }
    return null;
  }
  return null;
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  ctx: RuntimeContext,
): Promise<void> {
  // POST /runtime/sessions — 开会话
  app.post('/runtime/sessions', async (req, reply) => {
    const ownerId = resolveOwnerId(req, reply);
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, req.id);

    const loaded = await getPublishedCapability(ctx.pool, parsed.data.slugOrId);
    if (!loaded) return notFound(reply, req.id);

    // 开会话冻结：把 instructions 编排成 systemPrompt 快照 + 记下 manifestHash（之后契约改版不影响在途会话）。
    const systemPrompt = composeSystemPrompt(loaded.view);
    const meta = await createSession(ctx.pool, {
      ownerId,
      capabilityId: loaded.view.capabilityId,
      slug: loaded.publicView.slug,
      version: loaded.view.version,
      title: parsed.data.title ?? '新会话',
      instructions: systemPrompt,
      manifestHash: loaded.view.manifestHash,
      publicView: loaded.publicView,
    });
    return reply.code(201).send({ session: meta, capability: loaded.publicView });
  });

  // GET /runtime/sessions — 续话侧栏
  app.get('/runtime/sessions', async (req, reply) => {
    const ownerId = resolveOwnerId(req, reply);
    const items = await listSessions(ctx.pool, ownerId);
    return reply.send({ items });
  });

  // GET /runtime/sessions/:id — 会话详情（能力公开视图 + 历史消息 + 产物）
  app.get<{ Params: { id: string } }>('/runtime/sessions/:id', async (req, reply) => {
    const ownerId = resolveOwnerId(req, reply);
    const row = await getSessionRow(ctx.pool, req.params.id, ownerId);
    if (!row) return notFound(reply, req.id);

    const [messages, artifacts] = await Promise.all([
      getMessages(ctx.pool, row.id),
      getArtifacts(ctx.pool, row.id),
    ]);
    const detail: SessionDetail = {
      session: {
        id: row.id,
        capabilityId: row.capabilityId,
        slug: row.slug,
        version: row.version,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      capability: row.publicView,
      messages,
      artifacts,
    };
    return reply.send(detail);
  });

  // POST /runtime/agui — AG-UI 标准端点：收 RunAgentInput，回标准 AG-UI 事件流（SSE）。
  //   threadId 即 sessionId；只取最新一条 user 消息当新输入，其余仍以服务端 transcript 为真源。
  app.post('/runtime/agui', async (req, reply) => {
    const ownerId = resolveOwnerId(req, reply);
    const parsed = RunAgentInputSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, req.id);
    const input = parsed.data;

    const row = await getSessionRow(ctx.pool, input.threadId, ownerId);
    if (!row) return notFound(reply, req.id);

    const userText = latestUserText(input.messages);
    if (!userText) return badRequest(reply, req.id);

    const emitter = startAguiStream(req, reply, { threadId: input.threadId, runId: input.runId });
    void runAgui({
      env: ctx.env,
      pool: ctx.pool,
      session: row,
      userText,
      emitter,
      log: req.log,
    }).catch((err: unknown) => {
      req.log.error(err, 'runAgui crashed');
      emitter.runError('服务异常，请重试。');
      emitter.end();
    });
    return reply;
  });
}
