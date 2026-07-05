// upsert_artifact —— 暴露给 pi 的产物工具：模型调用它产出/更新一个产物（类 Claude Artifacts）。
//   execute：内容写 MinIO（键按 session+artifact 稳定，更新即覆写）→ artifacts 表插/更新行 →
//   经 onArtifact 回调交给上层发 AG-UI 产物更新事件。返回给模型的是简短回执（不回灌全文，省 token）。
import { randomUUID } from 'node:crypto';
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ArtifactView } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import {
  ARTIFACT_BUCKET,
  artifactStorageKey,
  contentTypeFor,
  readArtifactInSession,
  upsertArtifact,
} from './repo.js';

const ArtifactParams = Type.Object({
  artifactId: Type.Optional(
    Type.String({
      description:
        '要更新的产物 id（来自之前调用的回执）。省略 = 新建一个产物；同一份成品反复修改必须带同一个 id。',
    }),
  ),
  kind: StringEnum(['html', 'markdown', 'code', 'structured'], {
    description:
      'html=自包含可交互网页(沙箱iframe预览); markdown=富文本文档; code=单文件代码; structured=结构化JSON(评分/清单/字段表)。',
  }),
  title: Type.String({ description: '产物标题（展示在画布顶部）。' }),
  language: Type.Optional(
    Type.String({ description: 'kind=code 时的语言标注，如 ts/python/sql；其余 kind 可省。' }),
  ),
  content: Type.String({
    description:
      '产物完整内容。html 须为完整自包含 HTML 文档；structured 须为合法 JSON 字符串；其余为对应文本。',
  }),
});
type ArtifactParamsT = Static<typeof ArtifactParams>;

export interface ArtifactToolContext {
  db: Queryable;
  objectStore: RuntimeObjectStore;
  sessionId: string;
  /** 产出/更新一个产物后回调；run-turn 据此发 AG-UI 产物更新事件。 */
  onArtifact: (artifact: ArtifactView) => void;
}

export type ArtifactAgentTool = AgentTool<typeof ArtifactParams, { artifactId: string }>;

export function createArtifactTool(ctx: ArtifactToolContext): ArtifactAgentTool {
  return {
    name: 'upsert_artifact',
    label: '产出/更新产物',
    description:
      '把一份可独立留存的成品（文档/网页/代码/结构化数据）写成产物展示给用户。修改已有产物时带上回执里的 artifactId。',
    parameters: ArtifactParams,
    async execute(
      _toolCallId: string,
      params: ArtifactParamsT,
    ): Promise<AgentToolResult<{ artifactId: string }>> {
      // 模型给的 id 只有真实存在于本会话才算「更新」；否则按新建处理（防跨会话指涉/幻觉 id）。
      const requested = params.artifactId?.trim();
      const existing = requested
        ? await readArtifactInSession(ctx.db, requested, ctx.sessionId)
        : null;
      const id = existing?.id ?? randomUUID();

      const storageKey = artifactStorageKey(ctx.sessionId, id);
      await ctx.objectStore.putObject(
        ARTIFACT_BUCKET,
        storageKey,
        new TextEncoder().encode(params.content),
        { contentType: contentTypeFor(params.kind) },
      );
      const view = await upsertArtifact(ctx.db, {
        id,
        sessionId: ctx.sessionId,
        kind: params.kind,
        title: params.title,
        storageKey,
        meta: params.language ? { language: params.language } : {},
      });

      ctx.onArtifact(view);

      return {
        content: [
          {
            type: 'text',
            text:
              `已${existing ? '更新' : '产出'}产物「${params.title}」（artifactId=${id}，kind=${params.kind}），已在画布展示给用户。` +
              `后续修改同一产物请带同一个 artifactId。请用一两句话说明并邀请继续迭代，不要在正文重复产物全文。`,
          },
        ],
        details: { artifactId: id },
      };
    },
  };
}
