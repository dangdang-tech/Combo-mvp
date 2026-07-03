// 产物持久化（rt_chat_artifacts / rt_chat_artifact_versions）。类 Claude Artifacts 的版本演进：
//   同 (session, artifactKey) 再次 upsert = latest_version+1 + 追一行版本快照（历史可回看/切换）。
import type { Pool, PoolClient } from 'pg';
import type { ArtifactKind, ArtifactVersion, RuntimeArtifact } from '@cb/shared';

export interface UpsertArtifactInput {
  sessionId: string;
  artifactKey: string;
  kind: ArtifactKind;
  title: string;
  language: string | null;
  content: string;
}

export interface UpsertArtifactResult {
  version: number;
  artifact: ArtifactVersion;
}

/** upsert 一个产物版本（单事务）：升 latest_version + 追版本行；返回新版本号与版本快照。 */
export async function upsertArtifact(
  pool: Pool,
  input: UpsertArtifactInput,
): Promise<UpsertArtifactResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const head = await client.query<{ id: string; latest_version: number }>(
      `INSERT INTO rt_chat_artifacts (session_id, artifact_key, kind, title, latest_version)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (session_id, artifact_key)
       DO UPDATE SET latest_version = rt_chat_artifacts.latest_version + 1,
                     kind = EXCLUDED.kind,
                     title = EXCLUDED.title,
                     updated_at = now()
       RETURNING id, latest_version`,
      [input.sessionId, input.artifactKey, input.kind, input.title],
    );
    const row = head.rows[0];
    if (!row) throw new Error('upsertArtifact: head upsert returned no row');
    const version = row.latest_version;

    const ver = await client.query<{ created_at: Date }>(
      `INSERT INTO rt_chat_artifact_versions (artifact_id, version, kind, title, language, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING created_at`,
      [row.id, version, input.kind, input.title, input.language, input.content],
    );

    await client.query('COMMIT');

    const createdAt = (ver.rows[0]?.created_at ?? new Date()).toISOString();
    return {
      version,
      artifact: {
        artifactKey: input.artifactKey,
        version,
        kind: input.kind,
        title: input.title,
        language: input.language,
        content: input.content,
        createdAt,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface ArtifactDbRow {
  artifact_key: string;
  kind: ArtifactKind;
  title: string;
  latest_version: number;
  versions: ArtifactVersion[];
}

/** 取会话全部产物（含历史版本，面板版本切换用）。 */
export async function getArtifacts(pool: Pool, sessionId: string): Promise<RuntimeArtifact[]> {
  const res = await pool.query<ArtifactDbRow>(
    `SELECT a.artifact_key,
            a.kind,
            a.title,
            a.latest_version,
            COALESCE(
              json_agg(
                json_build_object(
                  'artifactKey', a.artifact_key,
                  'version',     v.version,
                  'kind',        v.kind,
                  'title',       v.title,
                  'language',    v.language,
                  'content',     v.content,
                  'createdAt',   to_char(v.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                )
                ORDER BY v.version
              ) FILTER (WHERE v.id IS NOT NULL),
              '[]'
            ) AS versions
       FROM rt_chat_artifacts a
       LEFT JOIN rt_chat_artifact_versions v ON v.artifact_id = a.id
      WHERE a.session_id = $1
        -- 只返回【被某条已落库消息引用】的产物：产物在工具 execute 内自成事务先提交，若该回合随后失败
        --   （断线/saveTurn 异常/LLM 运行时错误）assistant 消息没写成，产物就成了孤儿；按引用过滤掉它，
        --   避免详情里冒出一个没有对应回复、还自动展开的产物（孤儿行留库，可由后续 sweeper 清理）。
        AND EXISTS (
          SELECT 1 FROM rt_chat_messages m
           WHERE m.session_id = a.session_id
             AND m.artifacts @> jsonb_build_array(jsonb_build_object('artifactKey', a.artifact_key))
        )
      GROUP BY a.id, a.artifact_key, a.kind, a.title, a.latest_version
      ORDER BY a.created_at ASC`,
    [sessionId],
  );
  return res.rows.map((r) => ({
    artifactKey: r.artifact_key,
    kind: r.kind,
    title: r.title,
    latestVersion: r.latest_version,
    versions: Array.isArray(r.versions) ? r.versions : [],
  }));
}

/** 取单个产物的完整版本历史（不做"被消息引用"过滤；回合进行中渲染用）。无 → null。 */
export async function getArtifact(
  pool: Pool,
  sessionId: string,
  artifactKey: string,
): Promise<RuntimeArtifact | null> {
  const res = await pool.query<ArtifactDbRow>(
    `SELECT a.artifact_key,
            a.kind,
            a.title,
            a.latest_version,
            COALESCE(
              json_agg(
                json_build_object(
                  'artifactKey', a.artifact_key,
                  'version',     v.version,
                  'kind',        v.kind,
                  'title',       v.title,
                  'language',    v.language,
                  'content',     v.content,
                  'createdAt',   to_char(v.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                )
                ORDER BY v.version
              ) FILTER (WHERE v.id IS NOT NULL),
              '[]'
            ) AS versions
       FROM rt_chat_artifacts a
       LEFT JOIN rt_chat_artifact_versions v ON v.artifact_id = a.id
      WHERE a.session_id = $1 AND a.artifact_key = $2
      GROUP BY a.id, a.artifact_key, a.kind, a.title, a.latest_version
      LIMIT 1`,
    [sessionId, artifactKey],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    artifactKey: r.artifact_key,
    kind: r.kind,
    title: r.title,
    latestVersion: r.latest_version,
    versions: Array.isArray(r.versions) ? r.versions : [],
  };
}
