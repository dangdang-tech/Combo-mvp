// 会话路由：开会话（冻结 instructions + manifestHash 快照）/ 列表 / 详情 / 发消息（AG-UI 流式回合）。
import type { FastifyInstance } from 'fastify';
import { EventType, RunAgentInputSchema } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';
import {
  CreateSessionBodySchema,
  CreateTrialChainSessionBodySchema,
  RunInputSchema,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  UpdateSessionBodySchema,
  type RuntimeArtifact,
  type SessionDetail,
} from '@cb/shared';
import type { RuntimeContext } from '../../bootstrap/context.js';
import { badRequest, notFound } from '../../platform/http/errors.js';
import { requireCreatorIdentity, resolveRuntimeOwnerId } from '../../platform/http/auth.js';
import { startAguiStream } from '../agent/agui-emitter.js';
import { runAgui } from '../agent/agui-run.js';
import { composeSystemPrompt } from '../agent/compose-prompt.js';
import { getDraftCapabilityForTrial, getPublishedCapability } from '../capability/loader.js';
import { getArtifacts } from '../artifact/repo.js';
import { createRun, getRun, listRunEvents, setRunStatus, appendRunEvent } from '../run/repo.js';
import { createEventLogEmitter } from '../run/event-log-emitter.js';
import { currentTraceparent } from '../../platform/observability/node.js';
import {
  archiveSession,
  createSession,
  findEmptyTrialSession,
  getMessages,
  getMessagesPage,
  getSessionRow,
  listSessions,
  updateSessionTitle,
} from './repo.js';

/** 从 AG-UI RunAgentInput.messages 取最新一条 user 消息的文本（服务端只认这条做新输入，其余以本地转录为真源）。 */
function latestUserText(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): string | null {
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

function mockFullHtmlArtifact(): RuntimeArtifact {
  const now = new Date().toISOString();
  const content = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f7f4ef;color:#171717}
      main{min-height:100vh;display:grid;place-items:center;padding:32px}
      section{max-width:720px;border:1px solid #ded7cd;background:#fff;border-radius:8px;padding:28px}
      h1{margin:0 0 12px;font-size:28px} p{line-height:1.7}
    </style>
  </head>
  <body>
    <main><section>
      <h1>试用画布</h1>
      <p>这里会展示本轮 Agent 交付的 GenUI 结果。当前为空会话，先用 mock 画布占位；触发运行后将替换为真实产物。</p>
    </section></main>
  </body>
</html>`;
  return {
    artifactKey: 'mock-full-html',
    kind: 'html',
    title: '试用画布',
    latestVersion: 1,
    versions: [
      {
        artifactKey: 'mock-full-html',
        version: 1,
        kind: 'html',
        title: '试用画布',
        language: null,
        content,
        createdAt: now,
      },
    ],
  };
}

function effectiveArtifacts(
  messagesLength: number,
  artifacts: RuntimeArtifact[],
): RuntimeArtifact[] {
  return messagesLength === 0 && artifacts.length === 0 ? [mockFullHtmlArtifact()] : artifacts;
}

function runInputToText(input: unknown): string {
  const parsed = RunInputSchema.safeParse(input);
  if (!parsed.success) return '';
  const parts = parsed.data.contentParts
    .map((part) => {
      if (part.type === 'text') return part.text.trim();
      const label = part.alt ?? part.url ?? part.mimeType ?? '用户提供的图片';
      return `[图片：${label}]`;
    })
    .filter(Boolean);
  if (parsed.data.lockedElements?.length) {
    const locks = parsed.data.lockedElements
      .map(
        (item) =>
          `${item.elementKey}=${Array.isArray(item.value) ? item.value.join(', ') : item.value}`,
      )
      .join('; ');
    parts.push(`锁定要素：${locks}`);
  }
  return parts.join('\n\n').trim();
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  ctx: RuntimeContext,
): Promise<void> {
  const runControls = new Map<string, AbortController>();

  async function createRuntimeSession(input: {
    ownerId: string;
    slugOrId: string;
    versionId?: string;
    title?: string;
    mode?: 'consume' | 'trial';
    reuseEmpty?: boolean;
  }) {
    const loaded = input.versionId
      ? await getDraftCapabilityForTrial(ctx.pool, {
          capabilityId: input.slugOrId,
          versionId: input.versionId,
          creatorUserId: input.ownerId,
        })
      : await getPublishedCapability(ctx.pool, input.slugOrId);
    if (!loaded) return null;

    if (input.mode === 'trial' && input.reuseEmpty) {
      const existing = await findEmptyTrialSession(ctx.pool, {
        ownerId: input.ownerId,
        capabilityId: loaded.view.capabilityId,
        version: loaded.view.version,
      });
      if (existing) return { session: existing, capability: loaded.publicView };
    }

    const systemPrompt = composeSystemPrompt(loaded.view);
    const defaultTitle = input.mode === 'trial' ? `${loaded.publicView.name} 试用` : '新会话';
    const meta = await createSession(ctx.pool, {
      ownerId: input.ownerId,
      capabilityId: loaded.view.capabilityId,
      slug: loaded.publicView.slug,
      version: loaded.view.version,
      mode: input.mode ?? 'consume',
      title: input.title?.trim() || defaultTitle,
      instructions: systemPrompt,
      manifestHash: loaded.view.manifestHash,
      publicView: loaded.publicView,
    });
    return { session: meta, capability: loaded.publicView };
  }

  // POST /runtime/sessions — 开会话
  app.post('/runtime/sessions', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, req.id);
    if (!parsed.data.slugOrId) return badRequest(reply, req.id);
    const created = await createRuntimeSession({
      ownerId,
      slugOrId: parsed.data.slugOrId,
      title: parsed.data.title,
      mode: parsed.data.mode,
    });
    if (!created) return notFound(reply, req.id);
    return reply.code(201).send(created);
  });

  // POST /runtime/trial-chains/:capabilityId/sessions — 管理层：在能力试用链上开 Session。
  app.post<{ Params: { capabilityId: string } }>(
    '/runtime/trial-chains/:capabilityId/sessions',
    async (req, reply) => {
      const identity = await requireCreatorIdentity(req, reply, ctx.pool, ctx.env);
      if (!identity) return reply;
      const parsed = CreateTrialChainSessionBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, req.id);
      const created = await createRuntimeSession({
        ownerId: identity.userId,
        slugOrId: parsed.data.versionId
          ? req.params.capabilityId
          : parsed.data.slugOrId ?? req.params.capabilityId,
        versionId: parsed.data.versionId,
        title: parsed.data.title,
        mode: 'trial',
        reuseEmpty: true,
      });
      if (!created) return notFound(reply, req.id);
      return reply.code(201).send(created);
    },
  );

  // GET /runtime/sessions — 续话侧栏
  app.get<{ Querystring: { slug?: string } }>('/runtime/sessions', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
    const items = await listSessions(ctx.pool, ownerId, { slug: req.query.slug });
    return reply.send({ items });
  });

  // GET /runtime/trial-chains/:capabilityId/sessions — 管理层：能力下的试用 Session 列表。
  app.get<{ Params: { capabilityId: string } }>(
    '/runtime/trial-chains/:capabilityId/sessions',
    async (req, reply) => {
      const identity = await requireCreatorIdentity(req, reply, ctx.pool, ctx.env);
      if (!identity) return reply;
      const ownerId = identity.userId;
      const items = await listSessions(ctx.pool, ownerId, {
        capabilityId: req.params.capabilityId,
        mode: 'trial',
      });
      return reply.send({ capabilityId: req.params.capabilityId, sessions: items });
    },
  );

  // GET /runtime/sessions/:id — 会话详情（能力公开视图 + 历史消息 + 产物）
  app.get<{ Params: { id: string } }>('/runtime/sessions/:id', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
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
        mode: row.mode,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      capability: row.publicView,
      messages,
      artifacts: effectiveArtifacts(messages.length, artifacts),
    };
    return reply.send(detail);
  });

  // GET /runtime/sessions/:id/messages — 历史 detail 分页。
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/runtime/sessions/:id/messages',
    async (req, reply) => {
      const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
      const row = await getSessionRow(ctx.pool, req.params.id, ownerId);
      if (!row) return notFound(reply, req.id);
      const page = await getMessagesPage(ctx.pool, row.id, {
        cursor: parsePositiveInt(req.query.cursor, 0),
        limit: parsePositiveInt(req.query.limit, 30),
      });
      return reply.send(page);
    },
  );

  // PATCH /runtime/sessions/:id — 改标题。
  app.patch<{ Params: { id: string } }>('/runtime/sessions/:id', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
    const parsed = UpdateSessionBodySchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.title) return badRequest(reply, req.id);
    const session = await updateSessionTitle(ctx.pool, req.params.id, ownerId, parsed.data.title);
    if (!session) return notFound(reply, req.id);
    return reply.send({ session });
  });

  // DELETE /runtime/sessions/:id — 归档历史。
  app.delete<{ Params: { id: string } }>('/runtime/sessions/:id', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
    const ok = await archiveSession(ctx.pool, req.params.id, ownerId);
    if (!ok) return notFound(reply, req.id);
    return reply.code(204).send();
  });

  // POST /runtime/sessions/:id/runs — 运行层：触发一轮 Agent Loop，立即返回 runId。
  app.post<{ Params: { id: string } }>('/runtime/sessions/:id/runs', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
    const row = await getSessionRow(ctx.pool, req.params.id, ownerId);
    if (!row) return notFound(reply, req.id);
    const parsed = RunInputSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, req.id);
    const userText = runInputToText(parsed.data);
    if (!userText) return badRequest(reply, req.id);

    const run = await createRun(ctx.pool, {
      sessionId: row.id,
      ownerId,
      body: parsed.data,
    });
    const controller = new AbortController();
    runControls.set(run.id, controller);
    const emitter = createEventLogEmitter({
      pool: ctx.pool,
      threadId: row.id,
      runId: run.id,
      signal: controller.signal,
    });

    void runAgui({
      env: ctx.env,
      pool: ctx.pool,
      session: row,
      runId: run.id,
      userText,
      emitter,
      log: req.log,
    })
      .then(async (result) => {
        if (result === 'completed') await setRunStatus(ctx.pool, run.id, 'completed');
        else if (result === 'failed') await setRunStatus(ctx.pool, run.id, 'failed');
        else await setRunStatus(ctx.pool, run.id, 'interrupted');
      })
      .catch(async (err: unknown) => {
        req.log.error(err, 'explicit run crashed');
        await appendRunEvent(ctx.pool, run.id, {
          type: EventType.RUN_ERROR,
          message: '服务异常，请重试。',
        }).catch(() => undefined);
        await setRunStatus(ctx.pool, run.id, 'failed', 'run crashed').catch(() => undefined);
      })
      .finally(() => {
        runControls.delete(run.id);
      });

    return reply.code(202).send({
      run,
      eventsUrl: `/api/v1/runtime/runs/${run.id}/events`,
    });
  });

  // GET /runtime/runs/:runId/events — 断点续传 SSE。断开只停止订阅，不打断后端 run。
  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>(
    '/runtime/runs/:runId/events',
    async (req, reply) => {
      const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
      const run = await getRun(ctx.pool, req.params.runId, ownerId);
      if (!run) return notFound(reply, req.id);

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        [TRACE_ID_HEADER]: req.id,
        [TRACEPARENT_HEADER]: currentTraceparent(req.id),
      });
      reply.hijack();

      const encoder = new EventEncoder();
      let closed = false;
      let after = parsePositiveInt(req.query.after, 0);
      const lastEventId = req.headers['last-event-id'];
      if (typeof lastEventId === 'string') after = parsePositiveInt(lastEventId, after);
      req.raw.on('close', () => {
        closed = true;
      });

      while (!closed && !reply.raw.writableEnded) {
        const events = await listRunEvents(ctx.pool, run.id, after);
        for (const event of events) {
          after = event.id;
          reply.raw.write(`id: ${event.id}\n`);
          reply.raw.write(encoder.encode(event.event as Parameters<EventEncoder['encode']>[0]));
        }
        const current = await getRun(ctx.pool, run.id, ownerId);
        if (!current || (isTerminalStatus(current.status) && events.length === 0)) break;
        if (isTerminalStatus(current.status) && events.length > 0) continue;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!reply.raw.writableEnded) reply.raw.end();
      return reply;
    },
  );

  // POST /runtime/runs/:runId/interrupt — 打断运行，Session 保留，可继续开新 run。
  app.post<{ Params: { runId: string } }>('/runtime/runs/:runId/interrupt', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
    const run = await getRun(ctx.pool, req.params.runId, ownerId);
    if (!run) return notFound(reply, req.id);
    const controller = runControls.get(run.id);
    await appendRunEvent(ctx.pool, run.id, {
      type: EventType.RUN_ERROR,
      message: '运行已打断。',
    });
    controller?.abort();
    const updated = await setRunStatus(ctx.pool, run.id, 'interrupted');
    return reply.send({ run: updated ?? run });
  });

  // POST /runtime/agui — AG-UI 标准端点：收 RunAgentInput，回标准 AG-UI 事件流（SSE）。
  //   threadId 即 sessionId；只取最新一条 user 消息当新输入，其余仍以服务端 transcript 为真源。
  app.post('/runtime/agui', async (req, reply) => {
    const ownerId = await resolveRuntimeOwnerId(req, reply, ctx.pool, ctx.env);
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
      runId: input.runId,
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
