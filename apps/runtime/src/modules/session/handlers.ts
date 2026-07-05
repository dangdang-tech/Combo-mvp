// 会话域 HTTP handler：薄壳——校验入参、owner 校验、调 repo/runner、包响应信封。
// 非本人与不存在同样 404（不暴露存在性）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import {
  CreateSessionBodySchema,
  ErrorCode,
  SendMessageBodySchema,
  type CapabilityInputField,
  type Envelope,
  type MessageView,
  type SessionDetail,
  type SessionView,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { loadCapability, readCapabilitySummary } from '../capability/loader.js';
import { sendLoadFailure } from '../capability/handlers.js';
import { listArtifacts } from '../artifact/repo.js';
import {
  createSession,
  getMessages,
  getSession,
  listSessions,
  toSessionView,
  type SessionRow,
} from './repo.js';

/** owner-scoped 取会话，失败即回信封；成功返回行。 */
async function requireOwnedSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionRow | null> {
  const userId = req.auth?.userId;
  if (!userId) {
    sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    return null;
  }
  const { id } = req.params as { id: string };
  let session: SessionRow | null;
  try {
    session = await getSession(req.server.infra.db, id, userId);
  } catch (err) {
    req.log.error({ err, traceId: req.id }, 'read session failed');
    sendError(req, reply, ErrorCode.INTERNAL);
    return null;
  }
  if (!session) {
    sendError(req, reply, ErrorCode.NOT_FOUND);
    return null;
  }
  return session;
}

// ───────────────────────────── POST /runtime/sessions ─────────────────────────────

export function createSessionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const { db, objectStore } = req.server.infra;
    // 开会话前 loader 全链校验（权限闸 + 定义可解析），坏能力不留下空会话。
    let loaded;
    try {
      loaded = await loadCapability(db, objectStore, parsed.data.capabilityId, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'load capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (loaded.kind !== 'ok') return sendLoadFailure(req, reply, loaded);

    let session: SessionRow;
    try {
      session = await createSession(db, {
        capabilityId: loaded.capability.id,
        ownerUserId: userId,
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create session failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    const body: Envelope<SessionView> = { data: toSessionView(session), meta: { traceId: req.id } };
    reply.code(201).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /runtime/sessions ─────────────────────────────

export function listSessionsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    // 可选按能力过滤（侧栏只列当前能力下的会话）；非 UUID 直接拒（防 SQL uuid cast 报 500）。
    const { capabilityId } = req.query as { capabilityId?: string };
    if (capabilityId !== undefined && !z.string().uuid().safeParse(capabilityId).success) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }

    let sessions: SessionRow[];
    try {
      sessions = await listSessions(req.server.infra.db, userId, capabilityId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'list sessions failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    const body: Envelope<SessionView[]> = {
      data: sessions.map(toSessionView),
      meta: { traceId: req.id },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /runtime/sessions/:id ─────────────────────────────

export function getSessionDetailHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await requireOwnedSession(req, reply);
    if (!session) return reply;
    const { db, objectStore } = req.server.infra;

    try {
      const [capability, messages, artifacts] = await Promise.all([
        readCapabilitySummary(db, session.capabilityId),
        getMessages(db, session.id),
        listArtifacts(db, session.id),
      ]);
      // 能力行被删属于数据异常（会话仍指着它），按 500 收口而不是装作没会话。
      if (!capability) {
        req.log.error(
          { traceId: req.id, capabilityId: session.capabilityId },
          'capability row missing',
        );
        return sendError(req, reply, ErrorCode.INTERNAL);
      }
      // 开场表单字段与提示语在 MinIO 定义里；定义读不出不阻塞详情（退化为空数组，自由输入仍可用）。
      let inputs: CapabilityInputField[] = [];
      let starterPrompts: string[] = [];
      try {
        const loaded = await loadCapability(
          db,
          objectStore,
          session.capabilityId,
          session.ownerUserId,
        );
        if (loaded.kind === 'ok') {
          inputs = loaded.definition.inputs;
          starterPrompts = loaded.definition.starterPrompts;
        }
      } catch (err) {
        req.log.warn({ err, traceId: req.id }, 'load definition for detail failed, degrading');
      }
      const detail: SessionDetail = {
        session: toSessionView(session),
        capability: { ...capability, inputs, starterPrompts },
        messages: messages.map((m) => ({
          id: m.id,
          seq: m.seq,
          role: m.role,
          content: m.content,
          status: m.status,
          createdAt: m.createdAt,
        })),
        artifacts,
      };
      const body: Envelope<SessionDetail> = { data: detail, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read session detail failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

// ───────────────────────────── POST /runtime/sessions/:id/messages ─────────────────────────────

export function sendMessageHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await requireOwnedSession(req, reply);
    if (!session) return reply;
    const parsed = SendMessageBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const { db, objectStore } = req.server.infra;
    // 每轮重新加载定义（发布态/定义可能已变；owner 校验对会话主人重新走一遍权限闸）。
    let loaded;
    try {
      loaded = await loadCapability(db, objectStore, session.capabilityId, session.ownerUserId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'load capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (loaded.kind !== 'ok') return sendLoadFailure(req, reply, loaded);

    let result;
    try {
      result = await req.server.turns.startTurn({
        session,
        definition: loaded.definition,
        text: parsed.data.text,
        log: req.log,
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'start turn failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (result.status === 'busy') return sendError(req, reply, ErrorCode.SESSION_BUSY);

    // 202：user 消息已落库，生成在进程内异步跑；进展经 /stream 订阅。
    const message: MessageView = {
      id: result.userMessage.id,
      seq: result.userMessage.seq,
      role: result.userMessage.role,
      content: result.userMessage.content,
      status: result.userMessage.status,
      createdAt: result.userMessage.createdAt,
    };
    const body: Envelope<{ message: MessageView }> = {
      data: { message },
      meta: { traceId: req.id },
    };
    reply.code(202).send(body);
    return reply;
  };
}

// ───────────────────────────── POST /runtime/sessions/:id/interrupt ─────────────────────────────

export function interruptHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await requireOwnedSession(req, reply);
    if (!session) return reply;

    // 无进行中的轮 → interrupted=false（幂等，不当错误）。
    const interrupted = req.server.turns.interrupt(session.id);
    const body: Envelope<{ interrupted: boolean }> = {
      data: { interrupted },
      meta: { traceId: req.id },
    };
    reply.code(200).send(body);
    return reply;
  };
}
