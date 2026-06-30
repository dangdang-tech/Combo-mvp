// B-21 · 本机助手直传路由 handler（20-step1-import §3）。
//   1) POST /import/connect/pair       铸一次性配对码（网页侧 creator；requireRole+requireIdempotency 已守）。
//   2) GET  /import/connect/script      下发注入 BASE+code 的助手脚本（配对码 query 鉴权；非 JSON，可执行 sh+curl 脚本）。
//   3) POST /import/connect/upload      助手凭码全量直传原文 + 最后一片自动建 import Job（PairAuth 已守）。
//   4) GET  /import/connect/pair/:pairId 网页轮询配对/上传状态（requireAuth + owner 校验）。
// 隐私口径（文首硬约束）：助手把原文【全量上传】到云端，去敏在云端 worker；文案绝不出现「数据不出本机/仅传精简」。
// 失败一律出 ErrorEnvelope（人话 + action，绝不裸露 code/堆栈/DB 报错，脊柱 §3/§11.B）。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  buildError,
  ErrorCode,
  SSE_ROUTES,
  type ConnectUploadResult,
  type ImportSource,
  type JobView,
  type PairResult,
  type PairStatusView,
} from '@cb/shared';
import { isOwner } from '../../platform/middleware/auth.js';
import {
  buildConnectCommand,
  createImportJobForPairing,
  CURL_ONE_LINER,
  mintPairing,
  readPairingManifest,
  readPairingStatus,
  recordPartLanded,
} from './pairings-repo.js';
import { initialImportProgress } from './create-job.js';
import { readJobViewForRecovery } from './upload-manifest-repo.js';
import { renderConnectScript, renderExpiredScript } from './connect-script.js';

/** 该分片在 agora-raw 桶的 key（按 owner+pairId+partIndex 隔离，原文不落正式盘，导入-33）。 */
function rawPartKey(ownerUserId: string, pairId: string, partIndex: number): string {
  return `raw/${ownerUserId}/${pairId}/part-${partIndex}`;
}

/** 据请求头算对外 BASE（railway 反代给 x-forwarded-proto；缺省回落 host + https）。 */
function resolveBase(req: FastifyRequest): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.protocol ?? 'https');
  const host =
    (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.headers.host as string | undefined) ||
    'agora.app';
  return `${proto}://${host}`;
}

/** 合法 ImportSource 收窄（非法回落 'mixed'，助手常同时扫到 claude+codex）。 */
function coerceSource(raw: unknown): ImportSource {
  return raw === 'claude' || raw === 'codex' || raw === 'mixed' ? raw : 'mixed';
}

// ───────────────────────────── 1) 铸码 ─────────────────────────────

/**
 * POST /import/connect/pair（20 §3.1）。requireRole('creator') + requireIdempotency 已由路由守。
 *   铸一行 import_pairings（只存 hash，明文码随响应返一次）；组 PairResult（command 注入 BASE+code）。
 */
export function connectPairHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) {
      reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
      return reply;
    }
    const body = (req.body ?? {}) as { draftId?: string };

    let minted;
    try {
      minted = await mintPairing(req.server.infra.db, {
        ownerUserId: userId,
        ...(typeof body.draftId === 'string' ? { draftId: body.draftId } : {}),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'mint pairing failed');
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }

    const base = resolveBase(req);
    const result: PairResult = {
      pairId: minted.pairId,
      pairingCode: minted.pairingCode,
      command: buildConnectCommand(base, minted.pairingCode),
      curlOneLiner: CURL_ONE_LINER,
      expiresAt: minted.expiresAt,
    };
    reply.code(201).send({ data: result });
    return reply;
  };
}

// ───────────────────────────── 2) 脚本下发 ─────────────────────────────

/**
 * GET /import/connect/script?code=XXXXXX（20 §3.2）。配对码 query 鉴权（无登录态）。
 *   - 码 active → 200 text/x-shellscript：注入 BASE + pairId + pairingCode 的 sh+curl 助手脚本（经 `| sh` 跑）。
 *   - 码无效/过期 → 仍返回【可读 stderr 文案脚本】（不裸 JSON 错误码，硬规则②）；HTTP 404。
 *   pairId 由 code 反查注入（供上传定位行，Codex#3-r2）。
 */
export function connectScriptHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const code = (req.query as { code?: string } | undefined)?.code;
    const base = resolveBase(req);

    const sendExpired = (): FastifyReply => {
      // 脚本通道不裸 JSON 错误码：返回一段打印人话 stderr 的可执行脚本片段（硬规则②）。
      reply
        .code(404)
        .header('content-type', 'text/x-shellscript; charset=utf-8')
        .send(renderExpiredScript());
      return reply;
    };

    if (typeof code !== 'string' || code.length === 0) return sendExpired();

    // 据 code 反查 active 配对行拿 pairId（脚本注入 pairId + code 供上传定位行）。
    let pairId: string | undefined;
    try {
      const { hashPairingCode } = await import('../../platform/middleware/pair-auth.js');
      const res = await req.server.infra.db.query<{ id: string }>(
        `SELECT id FROM import_pairings
          WHERE pairing_code_hash = $1
            AND used_at IS NULL
            AND phase IN ('waiting','uploading')
            AND expires_at > now()`,
        [hashPairingCode(code)],
      );
      pairId = res.rows[0]?.id;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'connect script lookup failed');
      // 即使 DB 异常也走脚本通道的人话 stderr（不裸 JSON / 不裸 500 体）。
      return sendExpired();
    }

    if (!pairId) return sendExpired();

    reply
      .code(200)
      .header('content-type', 'text/x-shellscript; charset=utf-8')
      .send(renderConnectScript({ base, pairId, pairingCode: code }));
    return reply;
  };
}

// ───────────────────────────── 2b) 引导二进制下发 ─────────────────────────────

/** 二进制白名单：agora-import-{os}-{arch}，可选 .sha256 后缀（防路径穿越，只读固定目录下这几个文件）。 */
const BIN_ASSET_RE = /^agora-import-(darwin|linux)-(amd64|arm64)(\.sha256)?$/;

/** 二进制所在目录（容器内由 Dockerfile 注入 IMPORT_BIN_DIR=/app/import-bins）。 */
function importBinDir(): string {
  return process.env.IMPORT_BIN_DIR ?? '/app/import-bins';
}

/**
 * GET /import/connect/bin/:asset（20-step1-import §3.2b）。【公开】无鉴权——与 /connect/script 同为匿名可取的引导产物。
 *   引导脚本据平台拼出 asset 名（agora-import-{os}-{arch} 或其 .sha256）来此下载预编译 Go 二进制。
 *   - :asset 必须匹配白名单正则（^agora-import-(darwin|linux)-(amd64|arm64)(\.sha256)?$），否则 404（防路径穿越）。
 *   - 命中二进制 → 200 application/octet-stream，流式回文件字节。
 *   - 命中 .sha256 → 200 text/plain，回该二进制的 sha256 十六进制（Dockerfile 预生成）。
 *   - 文件不存在 / 路径逸出固定目录 / 非常规文件 → 404（绝不返 50x 或裸错误）。
 */
export function connectBinHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const asset = (req.params as { asset?: string } | undefined)?.asset ?? '';
    // 白名单校验（同时杜绝 '../'、绝对路径、子目录等穿越形态：只接受纯文件名形态的白名单）。
    if (!BIN_ASSET_RE.test(asset) || basename(asset) !== asset) {
      reply.code(404).send();
      return reply;
    }

    const dir = resolve(importBinDir());
    const filePath = resolve(join(dir, asset));
    // 防路径穿越纵深：解析后的绝对路径必须仍在固定目录内（asset 已是纯白名单文件名，这里再兜底）。
    if (filePath !== join(dir, asset) && !filePath.startsWith(dir + sep)) {
      reply.code(404).send();
      return reply;
    }

    // 文件须存在且是常规文件（不存在/是目录 → 404，不暴露内部错误）。
    try {
      const st = await stat(filePath);
      if (!st.isFile()) {
        reply.code(404).send();
        return reply;
      }
    } catch {
      reply.code(404).send();
      return reply;
    }

    if (asset.endsWith('.sha256')) {
      reply.code(200).header('content-type', 'text/plain; charset=utf-8').send(createReadStream(filePath));
      return reply;
    }
    reply
      .code(200)
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${asset}"`)
      .send(createReadStream(filePath));
    return reply;
  };
}

// ───────────────────────────── 3) 助手直传 + 建 Job ─────────────────────────────

/** 从 multipart 读出原文字节（缓冲以写桶 + 算 hash）+ 表单字段（消费文件流避免连接挂起）。 */
async function readUploadParts(req: FastifyRequest): Promise<{
  source: ImportSource;
  partIndex: number;
  totalParts?: number;
  hadFile: boolean;
  /** 缓冲的原文字节（写加密临时桶用，Codex P0-2）；hadFile=false 时为空。 */
  fileBuffer: Buffer;
}> {
  // partIndex/totalParts/source 优先取 query（与 pairId 同走 query，preHandler 友好），表单字段兜底。
  const q = (req.query ?? {}) as { partIndex?: string; totalParts?: string; source?: string };
  let source: ImportSource = q.source !== undefined ? coerceSource(q.source) : 'mixed';
  let partIndex = q.partIndex !== undefined ? Number(q.partIndex) || 0 : 0;
  let totalParts: number | undefined;
  if (q.totalParts !== undefined) {
    const n = Number(q.totalParts);
    if (Number.isFinite(n) && n > 0) totalParts = n;
  }
  let hadFile = false;
  const chunks: Buffer[] = [];

  // @fastify/multipart：迭代 parts，文件流必须被消费（drain）否则请求悬挂。
  const parts = (req as unknown as { parts: () => AsyncIterableIterator<unknown> }).parts();
  for await (const partUnknown of parts) {
    const part = partUnknown as {
      type: 'file' | 'field';
      fieldname: string;
      value?: unknown;
      file?: AsyncIterable<Buffer>;
    };
    if (part.type === 'file' && part.file) {
      hadFile = true;
      // 缓冲文件字节（写加密临时桶 + 算 content hash，Codex P0-2/P1-5）。
      for await (const chunk of part.file)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } else if (part.type === 'field') {
      const v = part.value;
      if (part.fieldname === 'source') source = coerceSource(v);
      else if (part.fieldname === 'partIndex') partIndex = Number(v) || partIndex;
      else if (part.fieldname === 'totalParts') {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) totalParts = n;
      }
    }
  }
  return { source, partIndex, totalParts, hadFile, fileBuffer: Buffer.concat(chunks) };
}

/**
 * POST /import/connect/upload?pairId=...&partIndex=...&totalParts=...（20 §3.3）。
 *   PairAuth（query pairId + Bearer code）+ requireIdempotency（per-part key）已由路由守。
 *   统一上传协议（Codex P0-1/P0-2/P1-4/P1-5/P1-8）：
 *     ① 把本片原文字节真实写加密临时桶 agora-raw（不再只 drain，Codex P0-2）。
 *     ② 把 { partIndex → { key, contentSha256 } } 登记进 import_pairings.landed_parts manifest（不置 used_at，P1-4）。
 *     ③ 据 totalParts 校验「全部分片到齐」才建 job（未齐回 uploading 无 jobId，Codex P1-8）；
 *        complete 时建 job 兑换 used_at + subject_ref 带 rawS3Keys（worker 据此拉原文，不再 IMPORT_NO_CONTENT，P0-2）。
 *   判别联合（Codex#14）：未齐 status:'uploading'（无 jobId）；齐全建 job 后 status:'job_created' + jobId + eventsUrl + jobView。
 *   助手扫到空（无文件 / 零字节）→ IMPORT_NO_CONTENT（change_input，导入-20）。
 */
export function connectUploadHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const pairAuth = req.pairAuth; // PairAuth 中间件已校验（query pairId + code），未过则不会到这
    if (!pairAuth) {
      reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
      return reply;
    }
    const { pairId, ownerUserId } = pairAuth;

    // 终态恢复短路（Codex P1-r6 助手路径统一口径，短路在「终态 409」之前）：
    //   PairAuth 已确认本配对 phase='job_created' 且凭正确 code 放行恢复——按 job_id 读出既有 job 的真实 JobView 直接返回，
    //   绝不解析 multipart / 不登记分片 / 不重复建 job（同配对 + 正确 code 重试恢复同一 job，非 401/409）。
    if (pairAuth.recovery) {
      const { jobId } = pairAuth.recovery;
      let rec;
      try {
        rec = await readJobViewForRecovery(req.server.infra.db, ownerUserId, jobId);
      } catch (err) {
        req.log.error({ err, traceId: req.id }, 'connect upload recovery read failed');
        reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
        return reply;
      }
      if (!rec) {
        // job 行已不存在（极端：被 GC，理论上 FK 阻止）→ 终态但回不出 job：按已用过引导重发。
        reply.code(409).send(
          buildError(ErrorCode.STATE_CONFLICT, req.id, {
            userMessage: '这个配对码已用过，回网页重新生成。',
            action: 'change_input',
          }),
        );
        return reply;
      }
      const jobView: JobView = {
        id: rec.jobId,
        type: 'import',
        status: rec.status,
        progress: rec.progress,
        attemptNo: rec.attemptNo,
        createdAt: rec.createdAt,
      };
      const result: ConnectUploadResult = {
        status: 'job_created',
        pairId,
        jobId: rec.jobId,
        eventsUrl: SSE_ROUTES.jobEvents(rec.jobId),
        jobView,
      };
      reply.code(200).send({ data: result });
      return reply;
    }

    let parsed;
    try {
      parsed = await readUploadParts(req);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'connect upload parse failed');
      // 上传途中读流失败 = 网络断/中断（导入-31）。
      reply.code(409).send(
        buildError(ErrorCode.UPLOAD_INTERRUPTED, req.id, {
          userMessage: '上传中断了，重跑命令续传。',
          action: 'retry',
          retriable: true,
        }),
      );
      return reply;
    }

    // 助手扫到空（本机无历史 / 空文件）→ 不建空骗人 job（导入-20）。
    if (!parsed.hadFile || parsed.fileBuffer.length === 0) {
      reply.code(400).send(
        buildError(ErrorCode.IMPORT_NO_CONTENT, req.id, {
          userMessage: '没扫到可导入的对话历史，去产生历史后再来，或换种导入方式。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    const db = req.server.infra.db;
    const s3Key = rawPartKey(ownerUserId, pairId, parsed.partIndex);
    const contentSha256 = createHash('sha256').update(parsed.fileBuffer).digest('hex');

    // ① 真实写加密临时桶（Codex P0-2）：原文落 agora-raw，worker 后续据 key 拉回。S3 不可用 → 人话 503。
    try {
      await req.server.infra.objectStore.putObject('agora-raw', s3Key, parsed.fileBuffer, {
        contentType: 'application/octet-stream',
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id, s3Key }, 'connect upload put object failed');
      reply.code(503).send(
        buildError(ErrorCode.DEPENDENCY_UNAVAILABLE, req.id, {
          userMessage: '系统正在恢复，请稍候重跑命令续传。',
          action: 'wait',
          retriable: true,
        }),
      );
      return reply;
    }

    // ② 登记进 manifest（受保护更新；不置 used_at，多分片途中可续传，Codex P1-4）。
    let landed;
    try {
      landed = await recordPartLanded(db, {
        pairId,
        partIndex: parsed.partIndex,
        s3Key,
        contentSha256,
        ...(parsed.totalParts !== undefined ? { totalParts: parsed.totalParts } : {}),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'record part landed failed');
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }
    if (!landed.recorded) {
      // 配对已用过 / 已终态（导入-19/§3.3）。
      reply.code(409).send(
        buildError(ErrorCode.STATE_CONFLICT, req.id, {
          userMessage: '这个配对码已用过，回网页重新生成。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    // ③ 未传齐：回 uploading（无 jobId，不裸转圈，Codex#14/P1-8）。
    if (!landed.complete) {
      const result: ConnectUploadResult = {
        status: 'uploading',
        pairId,
        uploadedParts: landed.uploadedParts,
        ...(landed.totalParts !== null ? { totalParts: landed.totalParts } : {}),
      };
      reply.code(200).send({ data: result });
      return reply;
    }

    // ④ 传齐：取 manifest 的有序 rawS3Keys 建 job（worker 据此拉原文，Codex P0-2/P1-8）。
    let manifest;
    try {
      manifest = await readPairingManifest(db, pairId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read pairing manifest failed');
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }
    // manifest 读不到（竞态：另一个并发请求已建 job 把配对推到 job_created）→ 走幂等回放。
    const rawS3Keys = manifest?.rawS3Keys ?? [s3Key];

    let created;
    try {
      created = await createImportJobForPairing(db, {
        pairId,
        ownerUserId,
        source: parsed.source,
        rawS3Keys,
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create import job for pairing failed');
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }
    if (!created) {
      // 配对已非 active（竞态/取消）→ 不建 job。
      reply.code(409).send(
        buildError(ErrorCode.STATE_CONFLICT, req.id, {
          userMessage: '这个配对码已用过，回网页重新生成。',
          action: 'change_input',
        }),
      );
      return reply;
    }

    // 入队触发云端解析（仅新建分支入队；回放分支 fenceToken=0 不重复入队，幂等）。
    if (created.fenceToken > 0) {
      try {
        await req.server.infra.queue.enqueue('import', created.jobId as never, created.fenceToken);
      } catch (err) {
        // 入队失败：助手路径 job 已建且配对已 job_created/used_at（兑换完成，回滚会丢配对状态），
        //   故不回滚——job 是真源，sweeper 的 staleQueued 会扫到停滞 queued 按 fence 补投（Codex P1-r2 防御纵深，
        //   非「假装 queued」：本路径 JobView/jobId 已合法生成，前端可正常订阅 SSE，补投后即开跑，不裸转圈）。
        req.log.warn(
          { err, jobId: created.jobId },
          'import job enqueue failed (sweeper staleQueued will requeue)',
        );
      }
    }

    // 完整 JobView（queued + 五项子任务 pending + attemptNo/createdAt，前端初始态不裸转圈，Codex P1-7）。
    const jobView: JobView = {
      id: created.jobId,
      type: 'import',
      status: 'queued',
      progress: initialImportProgress(),
      attemptNo: created.attemptNo,
      createdAt: created.createdAt,
    };
    const result: ConnectUploadResult = {
      status: 'job_created',
      pairId,
      jobId: created.jobId,
      eventsUrl: SSE_ROUTES.jobEvents(created.jobId),
      jobView,
    };
    reply.code(200).send({ data: result });
    return reply;
  };
}

// ───────────────────────────── 4) 网页轮询状态 ─────────────────────────────

/**
 * GET /import/connect/pair/:pairId（20 §3.4）。requireAuth 已守，handler 内 owner 校验。
 *   返回 PairStatusView（phase 与 ConnectUploadResult.status 同源同义，Codex#14）；
 *   过期未用 → phase=expired（前端态，有出口，非错误，导入-19）。
 */
export function connectPairStatusHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) {
      reply.code(401).send(buildError(ErrorCode.UNAUTHENTICATED, req.id));
      return reply;
    }
    const { pairId } = req.params as { pairId: string };

    let row;
    try {
      row = await readPairingStatus(req.server.infra.db, pairId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read pairing status failed');
      reply.code(500).send(buildError(ErrorCode.INTERNAL, req.id));
      return reply;
    }
    if (!row) {
      reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
      return reply;
    }
    // owner 校验：非本人配对 → 404（不暴露存在性，10-auth §6.3）。
    if (!isOwner(req, row.ownerUserId)) {
      reply.code(404).send(buildError(ErrorCode.NOT_FOUND, req.id));
      return reply;
    }

    const view: PairStatusView = {
      pairId,
      phase: row.phase,
      ...(row.jobId ? { jobId: row.jobId, eventsUrl: SSE_ROUTES.jobEvents(row.jobId) } : {}),
      uploadedParts: row.uploadedParts,
      ...(row.totalParts !== null ? { totalParts: row.totalParts } : {}),
    };
    reply.code(200).send({ data: view });
    return reply;
  };
}
