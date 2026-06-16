// B-21 · PairAuth 中间件（20-step1-import §3.3/§6.4，独立于 Logto JWT，脊柱 10-auth §2，Codex#5）。
//   本机助手直传（POST /import/connect/upload）走独立 PairAuth：
//   请求带 **query pairId**（`?pairId=...`，Codex P0-1：preHandler 不解析 multipart，pairId 走 query 而非表单字段）
//     + Authorization: Bearer <pairingCode>（pairingCode 是一次性配对码，非 Logto JWT、无 token exchange）。
//   服务端按 pairId 定位 import_pairings 行，timing-safe 比对 pairing_code_hash；失败计数按 pairId 成立。
//   校验链（20 §3.3 / §15）：phase ∈ {waiting,uploading} + 未过期(expires_at>now) + 未用尽(attempt_count<max_attempts) + 码 hash 匹配。
//   多分片协议（Codex P1-4）：used_at **不在此处置**——分片途中允许继续上传，used_at 只在 complete 兑换完成时落（pairings-repo）。
//   max_attempts 即时作废（Codex P1-6）：码错的同一条 UPDATE 内 attempt_count+1 >= max_attempts 时立即置 phase='expired'。
//   失败只出 ErrorEnvelope（绝不裸露内部 code / DB 报错，脊柱 §11.B）。
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { buildError, ErrorCode } from '@cb/shared';

/** PairAuth 解出的上下文（注入 req.pairAuth）。 */
export interface PairAuthContext {
  pairId: string;
  /** 配对绑定的创作者（导入产物归属，20 §6.4）。 */
  ownerUserId: string;
  /**
   * 终态恢复短路（Codex P1-r6 助手路径统一口径）：配对已 `phase='job_created'` 且 `job_id` 非空，
   *   同 pairId + **正确 code** 重试——放行【仅供按 job_id 恢复既有 jobView】，不再当作可上传 active 配对。
   *   仅在终态可恢复时有值（携 job_id）；非终态 active 配对此字段缺省。
   *   恢复优先于「used_at 401 / 终态 409」：handler 见此字段即短路返回既有 jobView，不解析 multipart、不登记、不建 job。
   */
  recovery?: { jobId: string };
}

/**
 * 配对码 hash（唯一真源）：SHA-256(code) hex。铸码端（POST /import/connect/pair，Phase 3）
 * 与本校验端共用此函数，保证「只存哈希、明文返一次」可比对（20 §6.3）。
 */
export function hashPairingCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** timing-safe 比对两个 hex 摘要（防时序侧信道；长度不等直接 false）。 */
function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 从请求取 pairId（**query string**）+ pairingCode（Bearer 头）。
 *   Codex P0-1：preHandler 不解析 multipart body（@fastify/multipart 的 body 在 preHandler 阶段尚未消费），
 *   故 pairId 统一走 query（`?pairId=...`），与契约 20 §3.3 / helper 脚本 / idempotency hash 一致。
 */
function extractPairCredentials(
  req: FastifyRequest,
): { pairId: string; pairingCode: string } | null {
  const authz = req.headers.authorization;
  if (!authz || !authz.startsWith('Bearer ')) return null;
  const pairingCode = authz.slice('Bearer '.length).trim();
  const query = req.query as { pairId?: string } | undefined;
  const pairId = query?.pairId;
  if (!pairId || !pairingCode) return null;
  return { pairId, pairingCode };
}

/** import_pairings 校验所需列。 */
interface PairingRow {
  owner_user_id: string;
  pairing_code_hash: string;
  phase: string;
  job_id: string | null;
  attempt_count: number;
  max_attempts: number;
  expired: boolean; // expires_at <= now()（在 SQL 算，避免时钟漂移）
  used: boolean; // used_at IS NOT NULL
}

/**
 * 校验配对码（20 §3.3 / §15）：按 pairId 定位 import_pairings，逐条校验后 timing-safe 比对 hash。
 *   - 行不存在 / 已过期 / 尝试次数用尽 → null（鉴权失败）。
 *   - **终态恢复短路（Codex P1-r6）**：phase='job_created' 且 job_id 非空 → 同 pairId + **正确 code** 放行【仅供恢复】，
 *     返回带 `recovery.jobId` 的上下文（短路在「used_at 401 / 终态 409」之前；码错仍拒，不当可上传 active 处理）。
 *     job_created 是终态、不被过期覆盖（与 readPairingStatus 同口径），故终态恢复不受 expired 拦。
 *   - active 路径：phase 非 waiting|uploading → null；码 hash 不匹配 → 原子 attempt_count +1（§11.A 受保护写入）后 null。
 *   - 全通过 → 返回 ownerUserId。
 * DB 异常 catch 收口为 null（绝不裸露原始报错，脊柱 §11.B）；上层据 null 出人话信封。
 */
async function verifyPairing(
  pairId: string,
  pairingCode: string,
  req: FastifyRequest,
): Promise<PairAuthContext | null> {
  const db = req.server.infra.db;
  try {
    const res = await db.query<PairingRow>(
      `SELECT owner_user_id,
              pairing_code_hash,
              phase,
              job_id,
              attempt_count,
              max_attempts,
              (expires_at <= now())   AS expired,
              (used_at IS NOT NULL)   AS used
         FROM import_pairings
        WHERE id = $1`,
      [pairId],
    );
    const row = res.rows[0];
    if (!row) return null; // 配对不存在

    const incoming = hashPairingCode(pairingCode);
    const codeMatches = safeHexEqual(incoming, row.pairing_code_hash);

    // 终态恢复短路（Codex P1-r6）：job_created + job_id 非空，凭【正确 code】放行【仅供按 job_id 恢复既有 jobView】。
    //   不当作可上传 active 配对（不置 used_at、不登记分片、不建 job）；恢复优先于 used/expired/终态拦。
    //   码错仍拒（不放行恢复；终态行的 attempt_count 谓词不再生效，无需计数）。
    if (row.phase === 'job_created' && row.job_id) {
      if (!codeMatches) return null;
      return { pairId, ownerUserId: row.owner_user_id, recovery: { jobId: row.job_id } };
    }

    if (row.used || row.expired) return null; // 已用 / 已过期（非终态恢复场景）
    if (row.phase !== 'waiting' && row.phase !== 'uploading') return null; // phase 不在可上传态
    if (row.attempt_count >= row.max_attempts) return null; // 尝试次数已用尽（已锁定）

    if (!codeMatches) {
      // 码错：失败计数原子 +1（按 pairId，仍在可计数态才加，防越界，§11.A）。
      // Codex P1-6：同一条 SQL 内 attempt_count+1 >= max_attempts 时立即置 phase='expired'（作废重铸，
      //   杜绝「达上限仍可继续试错」窗口）；无 TOCTOU（CASE 用 attempt_count 旧值算 +1 即可判定）。
      await db
        .query(
          `UPDATE import_pairings
              SET attempt_count = attempt_count + 1,
                  phase = CASE WHEN attempt_count + 1 >= max_attempts THEN 'expired' ELSE phase END,
                  updated_at = now()
            WHERE id = $1
              AND used_at IS NULL
              AND phase IN ('waiting','uploading')
              AND attempt_count < max_attempts`,
          [pairId],
        )
        .catch(() => undefined); // 计数写失败不改变「鉴权失败」结论
      return null;
    }

    return { pairId, ownerUserId: row.owner_user_id };
  } catch {
    // DB 异常：视为鉴权失败（不裸露原始报错）。
    return null;
  }
}

/** PairAuth 守卫：校验失败 → 401（人话，绝不裸露内部 code）。 */
export function requirePairAuth(): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const fail = (): FastifyReply =>
      reply.code(401).send(
        buildError(ErrorCode.UNAUTHENTICATED, req.id, {
          userMessage: '配对失效了，请回到网页重新生成连接码。',
          action: 'change_input',
        }),
      );

    const creds = extractPairCredentials(req);
    if (!creds) return fail();
    const ctx = await verifyPairing(creds.pairId, creds.pairingCode, req);
    if (!ctx) return fail();
    req.pairAuth = ctx;
  };
}
