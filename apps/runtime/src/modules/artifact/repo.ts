// artifacts 表 SQL。无版本：同一产物再次 upsert 原地覆盖（storage_key 稳定，MinIO 内容直接覆写）。
import type { ArtifactView } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { toIso } from '../session/repo.js';

/** 产物内容所在桶。 */
export const ARTIFACT_BUCKET = 'agora-artifacts' as const;

/** 产物内容对象键：按 (session, artifact) 稳定——同产物反复更新覆写同一对象。 */
export function artifactStorageKey(sessionId: string, artifactId: string): string {
  return `artifacts/${sessionId}/${artifactId}`;
}

/** kind → 回读时的 Content-Type（产物是文本类内容：网页/文档/代码/结构化 JSON）。 */
export function contentTypeFor(kind: string): string {
  switch (kind) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    case 'structured':
      return 'application/json; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

interface ArtifactDbRow {
  id: string;
  session_id: string;
  kind: string;
  title: string | null;
  storage_key: string;
  updated_at: string | Date;
}

function toView(r: ArtifactDbRow): ArtifactView {
  return {
    id: r.id,
    kind: r.kind,
    ...(r.title ? { title: r.title } : {}),
    updatedAt: toIso(r.updated_at),
  };
}

/** 插/更新一行（id 由调用方定；ON CONFLICT 原地覆盖 kind/title/meta）。 */
export async function upsertArtifact(
  db: Queryable,
  input: {
    id: string;
    sessionId: string;
    kind: string;
    title: string;
    storageKey: string;
    meta: Record<string, unknown>;
  },
): Promise<ArtifactView> {
  const res = await db.query<ArtifactDbRow>(
    `INSERT INTO artifacts (id, session_id, kind, title, storage_key, meta)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (id)
     DO UPDATE SET kind = EXCLUDED.kind,
                   title = EXCLUDED.title,
                   meta = EXCLUDED.meta,
                   updated_at = now()
     RETURNING id, session_id, kind, title, storage_key, updated_at`,
    [
      input.id,
      input.sessionId,
      input.kind,
      input.title,
      input.storageKey,
      JSON.stringify(input.meta),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('upsertArtifact: upsert returned no row');
  return toView(row);
}

/** 会话内查单个产物（tool 判定「更新还是新建」用）。 */
export async function readArtifactInSession(
  db: Queryable,
  artifactId: string,
  sessionId: string,
): Promise<{ id: string } | null> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM artifacts WHERE id = $1 AND session_id = $2 LIMIT 1`,
    [artifactId, sessionId],
  );
  return res.rows[0] ?? null;
}

/** 会话全部产物（详情画布恢复用），按创建先后。 */
export async function listArtifacts(db: Queryable, sessionId: string): Promise<ArtifactView[]> {
  const res = await db.query<ArtifactDbRow>(
    `SELECT id, session_id, kind, title, storage_key, updated_at
       FROM artifacts
      WHERE session_id = $1
      ORDER BY created_at ASC`,
    [sessionId],
  );
  return res.rows.map(toView);
}

/** owner-scoped 读产物（内容回读端点用）：JOIN sessions 校归属，非本人/不存在 → null。 */
export async function readArtifactForOwner(
  db: Queryable,
  artifactId: string,
  ownerUserId: string,
): Promise<{ id: string; kind: string; storageKey: string } | null> {
  const res = await db.query<{ id: string; kind: string; storage_key: string }>(
    `SELECT a.id, a.kind, a.storage_key
       FROM artifacts a
       JOIN sessions s ON s.id = a.session_id
      WHERE a.id = $1 AND s.owner_user_id = $2
      LIMIT 1`,
    [artifactId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? { id: row.id, kind: row.kind, storageKey: row.storage_key } : null;
}
