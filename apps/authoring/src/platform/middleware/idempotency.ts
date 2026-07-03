// B-09 · Idempotency-Key 中间件（脊柱 §4，Codex#6）。
//   所有写命令（POST/PATCH/DELETE）必带 Idempotency-Key 头 + 固定 scope（来自 @cb/shared IdempotencyScope）。
//   接 idempotency_keys 表实现契约行为矩阵（脊柱 §4.2）：
//     - 首次（key 不存在 / 旧租约已过期）：取租约（INSERT/steal）→ 执行 → onSend 落 response_ref（completed）。
//     - 重复 + request_hash 同 + 已完成：回放首次结果（首次 2xx body+status，对前端透明）。
//     - 重复 + request_hash 同 + 仍在租约中：423 RESOURCE_LOCKED（action:wait）。
//     - 重复 + request_hash 异：409 IDEMPOTENCY_CONFLICT。
//   判定在 app 层；绝不裸露 DB 报错（脊柱 §11.B），异常收口为 INTERNAL 信封。
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  buildError,
  ErrorCode,
  IdempotencyScope,
  IdempotencyStatus,
  type IdempotencyOptionalScopeValue,
  type IdempotencyScopeValue,
} from '@cb/shared';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** 租约时长（毫秒）：超过即认定旧持有者死/卡，可被新请求 steal（脊柱 §4 防死锁）。 */
const LEASE_TTL_MS = 60_000;

/** 注入 req.idempotency：scope + key + request_hash + 是否本次取得租约（onSend 据此落 response_ref）。 */
export interface IdempotencyContext {
  scope: IdempotencyScopeValue | IdempotencyOptionalScopeValue;
  key: string;
  requestHash: string;
  /** 本次请求是否取得了租约（true 才在 onSend 落 response_ref + 标 completed/failed）。 */
  leaseAcquired: boolean;
  /**
   * 本次持租的 fence token（Codex#4）：取/夺租约时生成。完成时 UPDATE 必须匹配 lease_token，
   * 防旧请求超时被 steal 后回来覆盖新请求的 response_ref。仅 leaseAcquired 时有值。
   */
  leaseToken?: string;
}

/** 落库的首次响应快照（回放用）。 */
interface ResponseRef {
  statusCode: number;
  body: unknown;
}

/**
 * 规范化请求算 request_hash（防同 key 不同请求复用，脊柱 §4.1）。
 *   - method + url（含 query string，已天然纳入 multipart 分片元数据 partIndex/contentSha256/pairId，Codex P1-5）。
 *   - body 仅取可序列化部分；multipart 二进制文件流不纳入 hash（preHandler 阶段未消费），
 *     分片的判别靠 url 上的 per-part 元数据 + helper 注入的 per-part Idempotency-Key（含 partIndex/content-hash）。
 *     这样每个分片是「同 scope 不同 key 不同 hash」，绝不互相 replay/冲突（Codex P1-5）。
 *   - **Authorization 纳入 hash 仅限 import.connect.upload（Codex P1-r6 + r7）**：助手直传用
 *     `Authorization: Bearer <pairingCode>`（**一次性配对码、会话内不轮换**）作主鉴权——不入 hash 则换错码复用同
 *     Idempotency-Key 可回放首次（正确码）的成功体，绕过码校验；纳入则换码 = 不同 hash → §4 行为矩阵判
 *     「同 key 不同 hash → 409 IDEMPOTENCY_CONFLICT」、绝不回放。
 *     **只对该 scope 纳入**（Codex r7 P2）：普通 Logto Bearer JWT 会轮换，若全局纳入则 token 刷新后同 key+同 body
 *     重试会被误判 409（而非按契约回放）；故其余 scope 不纳入 Authorization，避免幂等语义被 token 轮换污染。
 */
function computeRequestHash(
  req: FastifyRequest,
  scope: IdempotencyScopeValue | IdempotencyOptionalScopeValue,
): string {
  // 仅配对码鉴权的助手直传纳入 Authorization（配对码会话内稳定、不轮换）；其余 scope 不纳入（防 Logto JWT 轮换误 409）。
  const includeAuth = scope === IdempotencyScope.IMPORT_CONNECT_UPLOAD;
  const canonical = JSON.stringify({
    method: req.method,
    url: req.url,
    auth:
      includeAuth && typeof req.headers.authorization === 'string'
        ? req.headers.authorization
        : null,
    body: typeof req.body === 'object' && req.body !== null ? req.body : null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** idempotency_keys 行（判定所需列）。 */
interface IdemRow {
  request_hash: string;
  response_ref: ResponseRef | null;
  status: string;
  expired: boolean; // expires_at <= now()
}

function reply423(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(423).send(buildError(ErrorCode.RESOURCE_LOCKED, req.id));
}
function reply409(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(409).send(buildError(ErrorCode.IDEMPOTENCY_CONFLICT, req.id));
}
function reply500(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
}

/**
 * 尝试取租约（原子，脊柱 §4.2）：
 *   - INSERT ... ON CONFLICT DO NOTHING RETURNING：返回行 = 本次新建（取得租约）。
 *   - 无返回（已存在）：再读现有行判定（completed→回放、locked 未过期→423、locked 过期→steal、hash 异→409）。
 * 返回判定结果给中间件分发。
 */
type Decision =
  | { kind: 'acquired'; leaseToken: string } // 本次取得租约（带 fence token），放行执行
  | { kind: 'replay'; statusCode: number; body: unknown } // 回放首次结果
  | { kind: 'locked' } // 仍在租约中 → 423
  | { kind: 'conflict' } // request_hash 异 → 409
  | { kind: 'error' }; // DB 异常 → 500

async function acquireOrDecide(
  req: FastifyRequest,
  scope: string,
  key: string,
  requestHash: string,
): Promise<Decision> {
  const db = req.server.infra.db;
  try {
    // 本次取/夺租约的 fence token（Codex#4）：完成更新据此匹配当前持租者。
    const leaseToken = randomUUID();
    // 1) 试取新租约（仅当 (scope,key) 不存在时插入成功），写入本次 lease_token。
    const ins = await db.query<{ key: string }>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status, lease_token, locked_at, expires_at)
       VALUES ($1, $2, $3, 'locked', $5, now(), now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING key`,
      [scope, key, requestHash, String(LEASE_TTL_MS), leaseToken],
    );
    if (ins.rows.length > 0) return { kind: 'acquired', leaseToken };

    // 2) 已存在：读现有行判定。
    const sel = await db.query<IdemRow>(
      `SELECT request_hash, response_ref, status, (expires_at <= now()) AS expired
         FROM idempotency_keys
        WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const row = sel.rows[0];
    if (!row) {
      // 竞态：刚插入的行被并发删除/扫掉，极罕见。当作锁中处理（前端稍候重试）。
      return { kind: 'locked' };
    }

    // request_hash 不同 → key 被复用于不同请求（409）。
    if (row.request_hash !== requestHash) return { kind: 'conflict' };

    // 已完成 → 回放首次结果（response_ref 为空则视为无可回放、按已处理回 409 防重复执行）。
    if (row.status === IdempotencyStatus.COMPLETED) {
      if (row.response_ref) {
        return {
          kind: 'replay',
          statusCode: row.response_ref.statusCode,
          body: row.response_ref.body,
        };
      }
      // completed 但无 body（异常落库）：不重复执行，按冲突安全回。
      return { kind: 'conflict' };
    }

    // failed → 允许重试：steal 旧行（重置为本次租约）。
    // locked：未过期 → 423；过期 → steal（旧持有者死/卡）。
    if (row.status === IdempotencyStatus.FAILED || row.expired) {
      // 夺租约：写入本次 lease_token（旧持租者的 token 被覆盖，其完成更新将匹配不到，Codex#4）。
      const upd = await db.query<{ key: string }>(
        `UPDATE idempotency_keys
            SET request_hash = $3, status = 'locked', response_ref = NULL,
                lease_token = $5, locked_at = now(),
                expires_at = now() + ($4 || ' milliseconds')::interval
          WHERE scope = $1 AND key = $2
            AND (status = 'failed' OR expires_at <= now())
          RETURNING key`,
        [scope, key, requestHash, String(LEASE_TTL_MS), leaseToken],
      );
      if (upd.rows.length > 0) return { kind: 'acquired', leaseToken };
      // steal 竞态失败（被他人抢先）：当作锁中。
      return { kind: 'locked' };
    }

    // locked 且未过期 → 仍在处理中。
    return { kind: 'locked' };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * onSend 落 response_ref（脊柱 §4.2）：仅对【本次取得租约】的写命令生效。
 *   - 2xx → status=completed + response_ref（statusCode+body），供后续重复请求回放（24h 保留）。
 *   - 非 2xx → status=failed（允许后续重试同 key 重新取租约）。
 * 在 app.ts 注册【一次】全局 onSend 钩子调用本函数（不可每请求 addHook，会累积泄漏）。
 * 落库失败不影响对外响应（租约会过期被 steal/sweeper 清；绝不裸露 DB 报错，脊柱 §11.B）。
 */
export async function persistIdempotencyResponse(
  req: FastifyRequest,
  statusCode: number,
  payload: unknown,
): Promise<void> {
  const idem = req.idempotency;
  if (!idem || !idem.leaseAcquired || !idem.leaseToken) return;
  const db = req.server.infra.db;
  try {
    if (statusCode >= 200 && statusCode < 300) {
      // 解析 body（payload 多为已序列化字符串）落 response_ref，供回放。
      let body: unknown = null;
      if (typeof payload === 'string') {
        try {
          body = JSON.parse(payload);
        } catch {
          body = payload; // 非 JSON（如 text/javascript）：原样存
        }
      } else {
        body = payload ?? null;
      }
      const ref: ResponseRef = { statusCode, body };
      // fence（Codex#4）：必须匹配本次持租 lease_token；若已被 steal（旧请求超时后回来），
      //   lease_token 已变 → WHERE 匹配 0 行 → 不覆盖新持租者的 response_ref。
      await db.query(
        `UPDATE idempotency_keys
            SET status = 'completed', response_ref = $3, expires_at = now() + interval '24 hours'
          WHERE scope = $1 AND key = $2 AND status = 'locked' AND lease_token = $4`,
        [idem.scope, idem.key, JSON.stringify(ref), idem.leaseToken],
      );
    } else {
      // 失败：标 failed（允许后续重试同 key 重新取租约，§4.2 行为矩阵）。
      // 同样带 fence：只标自己持有的租约 failed，不动已被 steal 的新租约。
      await db.query(
        `UPDATE idempotency_keys
            SET status = 'failed'
          WHERE scope = $1 AND key = $2 AND status = 'locked' AND lease_token = $3`,
        [idem.scope, idem.key, idem.leaseToken],
      );
    }
  } catch {
    // 落库失败不影响对外响应（租约会过期被 steal/sweeper 清；脊柱 §11.B 不裸露）。
  }
}

/**
 * 必带 key 的写命令守卫（固定 scope）。
 *   缺 key → 400 VALIDATION_FAILED（人话）。
 *   接 idempotency_keys 实现行为矩阵（脊柱 §4.2）：取租约 / 回放 / 423 / 409。
 */
export function requireIdempotency(scope: IdempotencyScopeValue): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || key.length === 0) {
      reply.code(400).send(
        buildError(ErrorCode.VALIDATION_FAILED, req.id, {
          userMessage: '这个操作缺少防重复标识，请重试。',
          action: 'retry',
        }),
      );
      return reply;
    }
    const requestHash = computeRequestHash(req, scope);
    const decision = await acquireOrDecide(req, scope, key, requestHash);

    switch (decision.kind) {
      case 'acquired':
        // 取得租约：放行执行；onSend（app.ts 全局钩子）据 leaseAcquired + leaseToken 落 response_ref（fence）。
        req.idempotency = {
          scope,
          key,
          requestHash,
          leaseAcquired: true,
          leaseToken: decision.leaseToken,
        };
        return; // 放行执行
      case 'replay':
        // 回放首次结果（对前端透明）。body 已是对象 → 直接 send（fastify 序列化）。
        reply.code(decision.statusCode).send(decision.body);
        return reply;
      case 'locked':
        return reply423(req, reply);
      case 'conflict':
        return reply409(req, reply);
      case 'error':
      default:
        return reply500(req, reply);
    }
  };
}

/**
 * 「带请求体只读」POST 的可选 key（脊柱 §4.1 豁免：presign / preview，不写库）。
 * 有 key 则注入上下文（仍可用于去抖，但不取租约/不回放——这些端点无副作用），无 key 不报错。
 */
export function optionalIdempotency(scope: IdempotencyOptionalScopeValue): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    const key = req.headers[IDEMPOTENCY_HEADER];
    if (typeof key === 'string' && key.length > 0) {
      req.idempotency = {
        scope,
        key,
        requestHash: computeRequestHash(req, scope),
        leaseAcquired: false,
      };
    }
  };
}
