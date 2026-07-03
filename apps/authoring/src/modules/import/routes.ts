// 20 · 导入域路由（B-19/B-21，20-step1-import §3）。本期 501 占位。
//   - presign：「带请求体只读」POST，Idempotency 可选（脊柱 §4.1 豁免）。
//   - connect/upload：独立 PairAuth（pairId+pairingCode，不进 Logto JWT，脊柱 10-auth §2）。
//   - 其余写命令：requireRole('creator') + requireIdempotency。
//   - 快照读：requireAuth + handler owner 校验（10-auth §6.3）。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope, IdempotencyOptionalScope } from '@cb/shared';
import { requireAuth, requireRole } from '../../platform/middleware/auth.js';
import { requirePairAuth } from '../../platform/middleware/pair-auth.js';
import { optionalIdempotency, requireIdempotency } from '../../platform/middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import {
  connectBinHandler,
  connectPairHandler,
  connectPairStatusHandler,
  connectScriptHandler,
  connectUploadHandler,
} from './import-connect.js';
import {
  presignHandler,
  createJobHandler,
  getActiveImportJobHandler,
  getImportJobSnapshotHandler,
  getSnapshotHandler,
  listSegmentsHandler,
  listSnapshotsHandler,
} from './handlers.js';

export const IMPORT_ENDPOINTS: EndpointDecl[] = [
  // 带请求体只读 POST：Idempotency 可选（不写库，只签 URL）。
  {
    method: 'POST',
    url: '/import/uploads/presign',
    preHandlers: [
      requireRole('creator'),
      optionalIdempotency(IdempotencyOptionalScope.IMPORT_PRESIGN),
    ],
    handler: presignHandler(),
  },
  {
    method: 'POST',
    url: '/import/jobs',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.IMPORT_CREATE)],
    handler: createJobHandler(),
  },
  // 刷新恢复：active 必须排在 :jobId 前，避免被动态段吞掉。
  {
    method: 'GET',
    url: '/import/jobs/active',
    preHandlers: [requireAuth()],
    handler: getActiveImportJobHandler(),
  },
  {
    method: 'GET',
    url: '/import/jobs/:jobId',
    preHandlers: [requireAuth()],
    handler: getImportJobSnapshotHandler(),
  },
  // 本机助手配对：铸码（网页侧，creator）。
  {
    method: 'POST',
    url: '/import/connect/pair',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.IMPORT_CONNECT_PAIR)],
    handler: connectPairHandler(),
  },
  // 助手脚本下发（配对码 query 鉴权、无登录态；text/x-shellscript 可执行 sh+curl 引导脚本，码无效返人话 stderr 脚本）。
  { method: 'GET', url: '/import/connect/script', handler: connectScriptHandler() },
  // 引导二进制下发（公开、无鉴权，与 /connect/script 同为匿名引导产物）：白名单文件名读固定目录、防路径穿越。
  { method: 'GET', url: '/import/connect/bin/:asset', handler: connectBinHandler() },
  // 助手直传：独立 PairAuth + Idempotency（按 pairId 幂等）；最后一片自动建 import Job。
  {
    method: 'POST',
    url: '/import/connect/upload',
    preHandlers: [requirePairAuth(), requireIdempotency(IdempotencyScope.IMPORT_CONNECT_UPLOAD)],
    handler: connectUploadHandler(),
  },
  // 配对状态轮询（网页侧 creator 看自己的配对；handler 内 owner 校验）。
  {
    method: 'GET',
    url: '/import/connect/pair/:pairId',
    preHandlers: [requireAuth()],
    handler: connectPairStatusHandler(),
  },
  // 快照读：requireAuth + handler owner 校验。
  {
    method: 'GET',
    url: '/snapshots/:snapshotId',
    preHandlers: [requireAuth()],
    handler: getSnapshotHandler(),
  },
  {
    method: 'GET',
    url: '/snapshots/:snapshotId/segments',
    preHandlers: [requireAuth()],
    handler: listSegmentsHandler(),
  },
  {
    method: 'GET',
    url: '/snapshots',
    preHandlers: [requireAuth()],
    handler: listSnapshotsHandler(),
  },
];

export async function registerImportRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, IMPORT_ENDPOINTS);
}
