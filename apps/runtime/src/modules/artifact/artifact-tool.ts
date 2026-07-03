// upsert_artifact —— 会话级 pi 工具：模型调用它产出/更新一个 artifact（类 Claude Artifacts）。
//   execute 内：落库一个新版本 → 读回该产物完整版本历史 → 经 onArtifact 回调交给上层（不同线协议各自 emit）。
//   返回给模型的是简短回执（不回灌全文，省 token）；产物本体只走回调 + DB。
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Pool } from 'pg';
import type { ArtifactKind, ArtifactRef, RuntimeArtifact } from '@cb/shared';
import { getArtifact, upsertArtifact } from './repo.js';

const ArtifactParams = Type.Object({
  artifactKey: Type.String({
    description:
      '产物稳定标识。同一份成品反复修改时复用同一个 key（产生新版本）；不同成品用不同 key。常用 "main"。',
  }),
  kind: StringEnum(['html', 'markdown', 'code', 'structured'], {
    description:
      'html=自包含可交互网页(沙箱iframe预览); markdown=富文本文档; code=单文件代码; structured=结构化JSON(评分/清单/字段表)。',
  }),
  title: Type.String({ description: '产物标题（展示在面板顶部）。' }),
  language: Type.Optional(
    Type.String({ description: 'kind=code 时的语言标注，如 ts/python/sql；其余 kind 可省。' }),
  ),
  content: Type.String({
    description:
      '产物完整内容。html 须为完整自包含 HTML 文档；structured 须为合法 JSON 字符串；其余为对应文本。',
  }),
});
type ArtifactParamsT = Static<typeof ArtifactParams>;

interface ArtifactDetails {
  artifactKey: string;
  version: number;
}

export interface ArtifactToolContext {
  pool: Pool;
  sessionId: string;
  /** 本回合产出的 artifact 引用（run 落助手消息用）。 */
  collected: ArtifactRef[];
  /** 产出/更新一个产物后回调，带该产物的【完整版本历史】；线协议（自定义 SSE / AG-UI state）各自 emit。 */
  onArtifact: (artifact: RuntimeArtifact) => void;
}

export type ArtifactTool = ReturnType<typeof createArtifactTool>;

export function createArtifactTool(
  ctx: ArtifactToolContext,
): AgentTool<typeof ArtifactParams, ArtifactDetails> {
  return {
    name: 'upsert_artifact',
    label: '产出/更新产物',
    description:
      '把一份可独立留存的成品（文档/网页/代码/结构化数据）写成 artifact 展示给用户。同 artifactKey 再次调用即产生新版本。',
    parameters: ArtifactParams,
    async execute(
      _toolCallId: string,
      params: ArtifactParamsT,
    ): Promise<AgentToolResult<ArtifactDetails>> {
      const language = params.language ?? null;
      // StringEnum 的 Static 退化为 string；工具层已按 schema 校验 ∈ 四值，这里收窄回 ArtifactKind。
      const kind = params.kind as ArtifactKind;
      const { version } = await upsertArtifact(ctx.pool, {
        sessionId: ctx.sessionId,
        artifactKey: params.artifactKey,
        kind,
        title: params.title,
        language,
        content: params.content,
      });

      // 记入本回合 artifact 引用（同 key 覆盖为最新版本）。
      const ref: ArtifactRef = {
        artifactKey: params.artifactKey,
        version,
        kind,
        title: params.title,
      };
      const existing = ctx.collected.findIndex((r) => r.artifactKey === params.artifactKey);
      if (existing >= 0) ctx.collected[existing] = ref;
      else ctx.collected.push(ref);

      // 读回完整版本历史（不走"被消息引用"过滤——本回合消息尚未落库），交上层按协议 emit。
      const full = await getArtifact(ctx.pool, ctx.sessionId, params.artifactKey);
      if (full) ctx.onArtifact(full);

      return {
        content: [
          {
            type: 'text',
            text: `已产出 artifact「${params.title}」（key=${params.artifactKey}, v${version}，kind=${kind}），已在面板展示给用户。请用一两句话说明并邀请继续迭代，不要在正文重复产物全文。`,
          },
        ],
        details: { artifactKey: params.artifactKey, version },
      };
    },
  };
}
