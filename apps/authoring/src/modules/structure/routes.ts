// 40 · 选择 + 结构化域路由（B-24/B-25，40-step3-4-structure §3/§4）。
//   - selection.patch / capability.create / structure.start / manifest.patch / manifest.regenerate_field：
//     requireRole('creator') + requireIdempotency。本期 501 占位。
//   - structure/events SSE：requireSseAuth（同源 Cookie，禁 Authorization/query token，脊柱 §11.C）
//     + 建流前 owner 校验（structureSseHandler 内查库，缺 404/非 owner 403）。真实 text/event-stream：
//     首帧 state_snapshot（structure_state 全量）+ 15s 心跳 + Last-Event-ID 恢复协议。
//   - manifest 读（GET）：requireRole('creator') + handler owner 校验（40 §4.B / Codex#6）。本期 501 占位（handler owner 校验 Phase 3 接库）。
import type { FastifyInstance } from 'fastify';
import { IdempotencyScope } from '@cb/shared';
import { requireRole, requireSseAuth } from '../../platform/middleware/auth.js';
import { requireIdempotency } from '../../platform/middleware/idempotency.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { structureSseHandler } from '../../platform/http/_sse.js';
import {
  patchSelectionHandler,
  createCapabilityHandler,
  getManifestHandler,
  startStructureHandler,
  patchManifestHandler,
  regenerateFieldHandler,
} from './handlers.js';

export const STRUCTURE_ENDPOINTS: EndpointDecl[] = [
  // G · select 步（纯前端步的服务端落点：draft.selection 存草稿，§4.G）。
  {
    method: 'PATCH',
    url: '/drafts/:draftId/selection',
    preHandlers: [
      requireRole('creator'),
      requireIdempotency(IdempotencyScope.DRAFT_SELECTION_PATCH),
    ],
    handler: patchSelectionHandler(),
  },
  // A · 建能力体 draft 版本（三选一，§4.A）。
  {
    method: 'POST',
    url: '/capabilities',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.CAPABILITY_CREATE)],
    handler: createCapabilityHandler(),
  },
  // B · 读 manifest（创作者编辑态）：requireRole('creator') + handler owner 校验（40 §4.B，Codex#6）。
  // published 版本另由市集只读端点服务，本端点专供创作者本人编辑态读。
  {
    method: 'GET',
    url: '/versions/:versionId/manifest',
    preHandlers: [requireRole('creator')],
    handler: getManifestHandler(),
  },
  // C · 发起结构化 Job（§4.C，B-25/B-26）。
  {
    method: 'POST',
    url: '/versions/:versionId/structure',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.STRUCTURE_START)],
    handler: startStructureHandler(),
  },
  // D · SSE structure 流：同源 Cookie 鉴权（建流前 HTTP 失败，脊柱 §11.C）。owner 校验在 handler 建流前做。
  {
    method: 'GET',
    url: '/versions/:versionId/structure/events',
    preHandlers: [requireSseAuth()],
    handler: structureSseHandler(),
  },
  // E · 改软字段（§4.E，B-26）。
  {
    method: 'PATCH',
    url: '/versions/:versionId/manifest',
    preHandlers: [requireRole('creator'), requireIdempotency(IdempotencyScope.MANIFEST_PATCH)],
    handler: patchManifestHandler(),
  },
  // F · 单软字段重生成（§4.F，B-26）。
  {
    method: 'POST',
    url: '/versions/:versionId/manifest/fields/:field/regenerate',
    preHandlers: [
      requireRole('creator'),
      requireIdempotency(IdempotencyScope.MANIFEST_REGENERATE_FIELD),
    ],
    handler: regenerateFieldHandler(),
  },
];

export async function registerStructureRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, STRUCTURE_ENDPOINTS);
}
