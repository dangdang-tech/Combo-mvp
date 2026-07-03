// 60 个人主页 ⑤ 能力网络缩略共现自检（B-33，60-dashboard-profile §2.5，主页-10/14）。
//   重点：session/tag 共现即时生成、不依赖 embedding、thumbnailOnly 无展开、空态、weight 累加、规范化无向边。
import { describe, it, expect } from 'vitest';
import {
  buildNetwork,
  sessionCooccurEdges,
  tagOverlapEdges,
  type CooccurCapability,
  type SnapshotHit,
} from '../modules/profile/cooccur.js';
import { ProfileNetworkSchema } from '@cb/shared';

function cap(id: string, tags: string[] = [], size = 1): CooccurCapability {
  return { capabilityId: id, slug: `slug-${id}`, name: id, size, tags };
}

describe('sessionCooccurEdges（同 snapshot 命中多能力 → 共现边，§2.5）', () => {
  it('同一 snapshot 命中 A/B/C → 两两连边（session_cooccur）', () => {
    const hits: SnapshotHit[] = [{ snapshotId: 's1', capabilityIds: ['a', 'b', 'c'] }];
    const edges = sessionCooccurEdges(hits, new Set(['a', 'b', 'c']));
    expect(edges.size).toBe(3); // ab, ac, bc
    for (const e of edges.values()) {
      expect(e.basis).toBe('session_cooccur');
      expect(e.weight).toBe(1);
      expect(e.source < e.target).toBe(true); // 规范化无向边 source<target
    }
  });

  it('跨多个 snapshot 同一对共现 → weight 累加', () => {
    const hits: SnapshotHit[] = [
      { snapshotId: 's1', capabilityIds: ['a', 'b'] },
      { snapshotId: 's2', capabilityIds: ['a', 'b'] },
      { snapshotId: 's3', capabilityIds: ['a', 'b'] },
    ];
    const edges = sessionCooccurEdges(hits, new Set(['a', 'b']));
    expect(edges.size).toBe(1);
    expect([...edges.values()][0]!.weight).toBe(3);
  });

  it('snapshot 内同能力重复命中只算一次成员（不自连）', () => {
    const hits: SnapshotHit[] = [{ snapshotId: 's1', capabilityIds: ['a', 'a', 'b'] }];
    const edges = sessionCooccurEdges(hits, new Set(['a', 'b']));
    expect(edges.size).toBe(1); // 只有 ab，无 aa 自环
  });

  it('集合外能力不连入缩略（只统计入参能力集合内的对）', () => {
    const hits: SnapshotHit[] = [{ snapshotId: 's1', capabilityIds: ['a', 'b', 'x'] }];
    const edges = sessionCooccurEdges(hits, new Set(['a', 'b'])); // x 不在有效集
    expect(edges.size).toBe(1); // 只 ab
  });
});

describe('tagOverlapEdges（tags 重叠 → tag_overlap 边，§2.5）', () => {
  it('tags 有交集 → 连边，weight=重叠 tag 数', () => {
    const caps = [cap('a', ['保险', '增长']), cap('b', ['保险', '增长', '写作'])];
    const edges = tagOverlapEdges(caps);
    expect(edges.size).toBe(1);
    expect([...edges.values()][0]!.weight).toBe(2); // 保险+增长
    expect([...edges.values()][0]!.basis).toBe('tag_overlap');
  });

  it('tag 大小写/空白规范化后比较', () => {
    const caps = [cap('a', [' 保险 ', 'GROWTH']), cap('b', ['保险', 'growth'])];
    const edges = tagOverlapEdges(caps);
    expect([...edges.values()][0]!.weight).toBe(2);
  });

  it('无交集 → 不连边', () => {
    const caps = [cap('a', ['保险']), cap('b', ['写作'])];
    expect(tagOverlapEdges(caps).size).toBe(0);
  });
});

describe('buildNetwork（组装缩略，不依赖 embedding/capability_relations，主页-10）', () => {
  it('session + tag 双 basis 是不同边（同一对可既共现又重叠 → 两条边）', () => {
    const caps = [cap('a', ['保险']), cap('b', ['保险'])];
    const hits: SnapshotHit[] = [{ snapshotId: 's1', capabilityIds: ['a', 'b'] }];
    const net = buildNetwork({ caps, hits, centerId: 'a' });
    const bases = net.edges.map((e) => e.basis).sort();
    expect(bases).toEqual(['session_cooccur', 'tag_overlap']);
    expect(net.thumbnailOnly).toBe(true);
    expect(ProfileNetworkSchema.safeParse(net).success).toBe(true);
  });

  it('thumbnailOnly 恒 true、无展开/完整图谱入口字段（主页-10）', () => {
    const net = buildNetwork({ caps: [cap('a')], hits: [], centerId: 'a' });
    expect(net.thumbnailOnly).toBe(true);
    // 响应只含 nodes/edges/thumbnailOnly —— 无任何展开图谱 URL 字段。
    expect(Object.keys(net).sort()).toEqual(['edges', 'nodes', 'thumbnailOnly']);
  });

  it('centerId 标 isCenter；其余 false', () => {
    const net = buildNetwork({ caps: [cap('a'), cap('b')], hits: [], centerId: 'a' });
    expect(net.nodes.find((n) => n.capabilityId === 'a')!.isCenter).toBe(true);
    expect(net.nodes.find((n) => n.capabilityId === 'b')!.isCenter).toBe(false);
  });

  it('空态（<2 能力或无共现，主页-14）→ edges:[]（仅孤立节点），不报错', () => {
    const net = buildNetwork({ caps: [cap('a')], hits: [], centerId: 'a' });
    expect(net.edges).toEqual([]);
    expect(net.nodes).toHaveLength(1);
  });
});
