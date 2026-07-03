// 匿名 owner 身份（MVP）。试用端面向公开访问，会话按浏览器 cookie 隔离；将来接 Logto 换真实用户 id。
//   安全说明：本期未签名（低风险试用场景）；硬化时改 reply.setCookie 的 signed:true + COOKIE_SECRET。
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE = 'rt_uid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 读 cookie 取 owner id；无效/缺失则签发新 uuid 并下发。会话按它隔离（owner-scoped 读写）。 */
export function resolveOwnerId(req: FastifyRequest, reply: FastifyReply): string {
  const existing = req.cookies?.[COOKIE];
  if (existing && UUID_RE.test(existing)) return existing;
  const id = randomUUID();
  reply.setCookie(COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}
