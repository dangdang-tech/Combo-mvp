// ⑤ 能力网络缩略（主页-10）——以创作者为中心的能力图谱缩略预览，仅展示无展开图谱。
//
// 缩略边由后端 session/tag 共现即时生成（不依赖 embedding）。thumbnailOnly:true 是契约硬约束：
//   本分区绝不渲染任何「展开图谱 / 查看完整图谱 / 进入图谱」入口（主页-10）。
// 缩略用轻量 SVG 力导向预览（节点 + 边，节点大小按 size），ECharts 用于趋势/热力图等，此处缩略图量小、
//   只读不交互，用纯 SVG 更轻且可测（节点/边数可断言）。空（<2 能力或无共现）→ 中心单点/友好空态。
import type { ReactElement } from 'react';
import type { ProfileNetwork, NetworkNode } from '@cb/shared';

export interface NetworkSectionProps {
  network: ProfileNetwork;
  /** 缩略画布尺寸（正方形），默认 180。 */
  size?: number;
}

/** 环形布局：中心节点居中，其余均匀散布在外圈（缩略示意，非真力导向，量小够用）。 */
function layout(nodes: NetworkNode[], box: number): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const cx = box / 2;
  const cy = box / 2;
  const r = box * 0.36;
  const ring = nodes.filter((n) => !n.isCenter);
  const center = nodes.find((n) => n.isCenter) ?? nodes[0];
  if (center) pos.set(center.capabilityId, { x: cx, y: cy });
  ring.forEach((n, i) => {
    const angle = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.capabilityId, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  });
  return pos;
}

function nodeRadius(size: number): number {
  // size 是后端给的相对大小提示，夹到 4..11px 视觉范围。
  return Math.max(4, Math.min(11, 4 + size));
}

export function NetworkSection({ network, size = 180 }: NetworkSectionProps): ReactElement {
  const { nodes, edges } = network;
  const pos = layout(nodes, size);

  return (
    <section className="cb-profile-section cb-profile-network" aria-label="能力网络缩略">
      <h2 className="cb-profile-section__title">能力网络</h2>
      {nodes.length === 0 ? (
        <p className="cb-profile-network__empty">暂无能力网络</p>
      ) : (
        <svg
          className="cb-profile-network__thumb"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`能力网络缩略，${nodes.length} 个能力、${edges.length} 条关系`}
          data-thumbnail-only="true"
        >
          {edges.map((e, i) => {
            const a = pos.get(e.source);
            const b = pos.get(e.target);
            if (!a || !b) return null;
            return (
              <line
                key={`${e.source}-${e.target}-${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className="cb-profile-network__edge"
                data-basis={e.basis}
              />
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.capabilityId);
            if (!p) return null;
            return (
              <circle
                key={n.capabilityId}
                cx={p.x}
                cy={p.y}
                r={nodeRadius(n.size)}
                className="cb-profile-network__node"
                data-center={n.isCenter ? 'true' : undefined}
              >
                <title>{n.name}</title>
              </circle>
            );
          })}
        </svg>
      )}
      {/* 契约硬约束：无任何展开/完整图谱入口（主页-10）。此处刻意不渲染按钮/链接。 */}
    </section>
  );
}
