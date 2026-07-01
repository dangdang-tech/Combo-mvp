// 本地播种：插入 1~N 个【已发布】demo 能力（capabilities + capability_versions(status=published) +
//   capabilities.current_version_id + marketplace_listings 卡片），让试用端本地可跑可演示。
//   manifest_hash 用 @cb/shared 的 canonicalManifest（与 authoring 发布门同算法）+ sha256，确保 runtime 载入校验通过。
//   幂等：按 slug 已存在则跳过。需 DATABASE_URL（默认连本地 compose 的 PG）。
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { canonicalManifest, ManifestSchema, type Manifest, type OutputType } from '@cb/shared';

interface DemoDef {
  slug: string;
  name: string;
  tagline: string;
  role: string;
  goal: string;
  instructions: string;
  inputs: Manifest['inputs'];
  output: Manifest['output'];
  boundaries: Manifest['boundaries'];
  starterPrompts: string[];
}

const DEMOS: DemoDef[] = [
  {
    slug: 'visual-brief',
    name: '可视化简报生成器',
    tagline: '把主题与要点变成一页式可交互的 HTML 简报',
    role: '信息设计师',
    goal: '把用户给的主题与要点，做成一页式、可独立打开的可视化 HTML 简报',
    instructions: [
      '你是一名资深信息设计师。根据用户给的主题与要点，产出一页式、可独立打开的可视化 HTML 简报。',
      '要求：单文件自包含（内联 <style> 与必要的 <script>），现代干净的版式，响应式，信息层级清晰，可含简单图表（用内联 SVG 或 Canvas，勿依赖需要鉴权的私有资源；可用公共 CDN）。',
      '要点不足时可合理组织结构与排版，但不要编造具体数据或事实。',
      '务必通过 upsert_artifact 工具产出，kind=html，artifactKey="main"，content 为完整 HTML 文档（含 <!doctype html>）。',
      '产出后用一两句话说明并邀请用户继续调整（配色、结构、补充要点等）。',
    ].join('\n'),
    inputs: {
      fields: [
        {
          key: 'topic',
          label: '主题',
          type: 'string',
          required: true,
          derivedFrom: 'instructions',
        },
        {
          key: 'points',
          label: '要点（可选，每行一条）',
          type: 'text',
          required: false,
          derivedFrom: 'instructions',
        },
      ],
    },
    output: { type: 'text' },
    boundaries: {
      riskLevel: 'low',
      redLines: ['不编造未提供的数据或事实', '不输出有害、违法或误导性内容'],
    },
    starterPrompts: [
      '给我做一页「2024 主流 AI 编程工具对比」的可视化简报',
      '把这些要点做成一页可视化简报：我们产品的三大卖点是 A、B、C',
    ],
  },
  {
    slug: 'competitor-scorecard',
    name: '竞品情报评分卡',
    tagline: '针对一个竞品，多维度打分并给出依据',
    role: '竞品情报分析师',
    goal: '对一个竞品产出多维度评分卡（含分数与依据）',
    instructions: [
      '你是一名竞品情报分析师。针对用户给的竞品，从若干维度（如：产品力 / 增长 / 商业模式 / 生态 / 风险）做 1–5 分评分，并给出每项依据。',
      '务必通过 upsert_artifact 工具产出，kind=structured，artifactKey="scorecard"，content 为合法 JSON 字符串，结构形如：',
      '{"competitor":"…","overall":4.2,"dimensions":[{"name":"产品力","score":4,"rationale":"…"}, …]}。',
      '信息不足时给出基于公开常识的合理估计，并在 rationale 中明确标注为「推测」；不要把编造的具体数字当作事实。',
      '产出后用一两句话总结并邀请用户补充维度或深挖某一项。',
    ].join('\n'),
    inputs: {
      fields: [
        {
          key: 'competitor',
          label: '竞品名称',
          type: 'string',
          required: true,
          derivedFrom: 'instructions',
        },
        {
          key: 'dimensions',
          label: '关注维度（可选）',
          type: 'text',
          required: false,
          derivedFrom: 'instructions',
        },
      ],
    },
    output: { type: 'score' },
    boundaries: {
      riskLevel: 'medium',
      redLines: ['不编造无依据的事实或数据', '对不确定的信息须标注为推测'],
    },
    starterPrompts: ['评估一下 Cursor 作为 AI 编程工具的竞争力', '给 Notion 做一张竞品情报评分卡'],
  },
];

function typeLabel(t: OutputType): string {
  switch (t) {
    case 'text':
      return '写作';
    case 'structured':
      return '结构化文档';
    case 'score':
      return '评估打分';
    case 'checklist':
      return '核查清单';
    default:
      return '能力';
  }
}

function hashOf(manifest: Manifest): string {
  return createHash('sha256').update(canonicalManifest(manifest), 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgres://agora:agora@localhost:5432/agora';
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const userRes = await client.query<{ id: string; account: string }>(
      `SELECT id, account FROM users ORDER BY created_at ASC LIMIT 1`,
    );
    const user = userRes.rows[0];
    if (!user) {
      throw new Error('seed: 库里没有任何 users，先建一个用户再播种（创作者归属需要）。');
    }

    for (const demo of DEMOS) {
      const exists = await client.query<{ id: string }>(
        `SELECT id FROM capabilities WHERE slug = $1`,
        [demo.slug],
      );
      if (exists.rows[0]) {
        console.log(`skip（已存在）：${demo.slug}`);
        continue;
      }

      const capabilityId = randomUUID();
      const versionId = randomUUID();
      const manifest: Manifest = ManifestSchema.parse({
        id: capabilityId,
        version: '1.0.0',
        status: 'draft',
        inputs: demo.inputs,
        output: demo.output,
        boundaries: demo.boundaries,
        name: demo.name,
        tagline: demo.tagline,
        role: demo.role,
        goal: demo.goal,
        instructions: demo.instructions,
        skill_set: [],
        starter_prompts: demo.starterPrompts,
      });
      const manifestHash = hashOf(manifest);

      const card = {
        versionId,
        capabilityId,
        slug: demo.slug,
        cover: { source: 'glyph', url: null },
        typeLabel: typeLabel(demo.output.type),
        name: demo.name,
        tagline: demo.tagline,
        summary: demo.goal,
        byline: `@${user.account}`,
        trustBadge: '源自一次真实会话',
        price: { priceMicros: 0, display: '免费' },
        trialEnabled: false,
        installs: null,
        rating: null,
      };

      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO capabilities (id, creator_user_id, slug, tags, status)
           VALUES ($1, $2, $3, '{}', 'active')`,
          [capabilityId, user.id, demo.slug],
        );
        await client.query(
          `INSERT INTO capability_versions
             (id, capability_id, version, status, manifest, manifest_hash, structure_state, visibility)
           VALUES ($1, $2, '1.0.0', 'published', $3::jsonb, $4, '{}'::jsonb, 'public')`,
          [versionId, capabilityId, JSON.stringify(manifest), manifestHash],
        );
        await client.query(
          `UPDATE capabilities SET current_version_id = $2, updated_at = now() WHERE id = $1`,
          [capabilityId, versionId],
        );
        await client.query(
          `INSERT INTO marketplace_listings
             (capability_id, version_id, slug, card, search_tsv, status)
           VALUES ($1, $2, $3, $4::jsonb, to_tsvector('simple', $5), 'published')`,
          [capabilityId, versionId, demo.slug, JSON.stringify(card), `${demo.name} ${demo.tagline}`],
        );
        await client.query('COMMIT');
        console.log(`seeded：${demo.slug}（${demo.name}）capability=${capabilityId}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('seed done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[seed] fatal', err);
  process.exit(1);
});
