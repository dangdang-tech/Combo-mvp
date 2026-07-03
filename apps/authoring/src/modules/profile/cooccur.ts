// 60 · 能力网络缩略共现生成（B-33 ⑤，60-dashboard-profile §2.5，主页-10）。纯逻辑、不写库、便于单测。
//   口径（决策⑥ + 差异 §9 第 9 条）：缩略边用 session/tag 共现【即时生成】——
//     - 'session_cooccur'：同一 snapshot_id 下被多条 candidate_evidence 命中的能力两两连边（weight=共现命中次数）。
//     - 'tag_overlap'：capabilities.tags[] 重叠的能力连边（weight=重叠 tag 数）。
//   绝不读 capability_relations、绝不触发/读 embedding（B-37 保持 P1，不作主页缩略数据源）。
//   thumbnailOnly:true 恒成立——仅缩略、无展开图谱入口（响应不含任何展开/完整图谱字段）。
import type { NetworkNode, NetworkEdge, NetworkEdgeBasis, ProfileNetwork } from '@cb/shared';

/** 参与共现的能力（已上墙/在售口径由调用方过滤；此处只做共现计算）。 */
export interface CooccurCapability {
  capabilityId: string;
  slug: string;
  name: string;
  /** 节点大小提示（按 supportingSegments / 密度，真实）。 */
  size: number;
  /** 该能力的 tags（audience/domain/scene 三类合并，规范化小写去空，§2.5）。 */
  tags: string[];
}

/** 段级共现输入：某 snapshot 下命中了哪些能力（candidate_evidence × session_segments 同 snapshot 聚合）。 */
export interface SnapshotHit {
  snapshotId: string;
  capabilityIds: string[];
}

/** 规范化无向边键（capability_a < capability_b，与 creator_capability_cooccur CHECK 一致）。 */
function edgeKey(a: string, b: string, basis: NetworkEdgeBasis): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}|${hi}|${basis}`;
}
function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * session 共现边（§2.5）：同一 snapshot 下命中的能力两两连边，weight 累加跨 snapshot 命中次数。
 *   只统计【入参能力集合内】的两两对（外部能力不连入缩略）。
 */
export function sessionCooccurEdges(
  hits: SnapshotHit[],
  validIds: Set<string>,
): Map<string, NetworkEdge> {
  const edges = new Map<string, NetworkEdge>();
  for (const hit of hits) {
    // 去重 + 限定在有效集合内（同 snapshot 多次命中同能力只算一次成员）。
    const members = [...new Set(hit.capabilityIds)].filter((id) => validIds.has(id)).sort();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!;
        const b = members[j]!;
        const key = edgeKey(a, b, 'session_cooccur');
        const existing = edges.get(key);
        if (existing) {
          existing.weight += 1;
        } else {
          const [source, target] = ordered(a, b);
          edges.set(key, { source, target, weight: 1, basis: 'session_cooccur' });
        }
      }
    }
  }
  return edges;
}

/**
 * tag 重叠边（§2.5）：tags[] 有交集的能力两两连边，weight=重叠 tag 数（>0 才连）。
 *   tag 比较用规范化小写串；空 tag 不计。
 */
export function tagOverlapEdges(caps: CooccurCapability[]): Map<string, NetworkEdge> {
  const edges = new Map<string, NetworkEdge>();
  const tagSets = caps.map((c) => ({
    id: c.capabilityId,
    tags: new Set(c.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
  }));
  for (let i = 0; i < tagSets.length; i += 1) {
    for (let j = i + 1; j < tagSets.length; j += 1) {
      const x = tagSets[i]!;
      const y = tagSets[j]!;
      let overlap = 0;
      for (const t of x.tags) if (y.tags.has(t)) overlap += 1;
      if (overlap <= 0) continue;
      const [source, target] = ordered(x.id, y.id);
      edges.set(edgeKey(x.id, y.id, 'tag_overlap'), {
        source,
        target,
        weight: overlap,
        basis: 'tag_overlap',
      });
    }
  }
  return edges;
}

/**
 * 组装能力网络缩略（主页-10）。即时生成 nodes + (session_cooccur ∪ tag_overlap) edges。
 *   - centerId（创作者锚点：密度榜首/调用最多能力）标 isCenter=true；其余 false。
 *   - 空态（< 2 能力或无共现）→ edges:[]（仅孤立节点），不报错（主页-14）。
 *   - 恒 thumbnailOnly:true：不返回任何展开/完整图谱入口字段（主页-10）。
 */
export function buildNetwork(input: {
  caps: CooccurCapability[];
  hits: SnapshotHit[];
  centerId?: string | null;
}): ProfileNetwork {
  const validIds = new Set(input.caps.map((c) => c.capabilityId));
  const nodes: NetworkNode[] = input.caps.map((c) => ({
    capabilityId: c.capabilityId,
    slug: c.slug,
    name: c.name,
    size: c.size,
    isCenter: input.centerId != null && c.capabilityId === input.centerId,
  }));

  const session = sessionCooccurEdges(input.hits, validIds);
  const tag = tagOverlapEdges(input.caps);
  // 两种 basis 是不同边（同一对能力可既 session 共现又 tag 重叠 → 两条不同 basis 的边）。
  const edges: NetworkEdge[] = [...session.values(), ...tag.values()];

  return { nodes, edges, thumbnailOnly: true };
}
