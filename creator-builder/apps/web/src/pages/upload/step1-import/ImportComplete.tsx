// STEP① 导入完成态（F-10，开工总纲 §5.1.3）——成功横幅 + 原始数据统计四格 + 原始会话列表（只读）。
//
// 完成态（导入-13/14/15/16/27）：
//   1. 成功横幅（§5.1.3 逐字，导入-13）：主行「已导入全部对话历史（Codex + Claude）」（来源动态拼）+
//      副行「生成了一份原始数据，下一步从中提取能力项」+「重新导入」链接（触发重新导入流程，回 empty 态重铸码）。
//   2. 统计四格（真实值，非 usage 占位）：会话段数 / 消息条数 / 时间跨度 / 涉及项目数。
//   3. 原始会话列表（只读）：去敏后标题 + 日期 + 条数；readOnly:true 契约级保证（导入-15/16）。
//   底栏「下一步：提取能力项 →」由容器 ImportStepPage 注册主按钮，不在本件渲染（§5.0 底栏恒定）。
import type { ReactElement } from 'react';
import type { SnapshotView, SnapshotSegmentView, ImportSource } from '@cb/shared';

export interface ImportCompleteProps {
  /** 快照统计 + 去敏报告（GET /snapshots/{id}）。 */
  snapshot: SnapshotView;
  /** 原始会话节选（只读列表，GET /snapshots/{id}/segments）。 */
  segments: SnapshotSegmentView[];
  /** 点「重新导入」（导入-13）：回空态重新发起导入流程（旧快照后端保留，导入-21）。 */
  onReimport: () => void;
}

/** 来源人话（横幅「Codex + Claude」口径，导入-27）。 */
const SOURCE_LABEL: Record<ImportSource, string> = {
  claude: 'Claude',
  codex: 'Codex',
  mixed: 'Claude + Codex',
};

/** 命中来源集合 → 横幅文案（缺 sources 退回单 source）。 */
function sourcesText(snapshot: SnapshotView): string {
  const set = snapshot.sources.length > 0 ? snapshot.sources : [snapshot.source];
  const names = Array.from(
    new Set(set.map((s) => (s === 'mixed' ? null : SOURCE_LABEL[s])).filter(Boolean)),
  );
  if (names.length === 0) return SOURCE_LABEL[snapshot.source];
  return names.join(' + ');
}

/** 时间跨度文案「2026.03 – 2026.06」（缺则「—」）。 */
function timeSpanText(snapshot: SnapshotView): string {
  const span = snapshot.stats.timeSpan;
  if (!span) return '—';
  return `${span.from} – ${span.to}`;
}

/** 千分位（消息条数等大数好读）。 */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export function ImportComplete({
  snapshot,
  segments,
  onReimport,
}: ImportCompleteProps): ReactElement {
  const { stats } = snapshot;
  return (
    <section className="cb-import-done" aria-label="导入完成">
      {/* 1. 成功横幅（§5.1.3 / 导入-13：主行来源口径 + 副行下一步指引 + 重新导入入口）。 */}
      <div className="cb-import-done__banner" role="status">
        <span className="cb-import-done__banner-icon" aria-hidden="true">
          ✓
        </span>
        <div className="cb-import-done__banner-body">
          <p className="cb-import-done__banner-title">
            已导入全部对话历史（{sourcesText(snapshot)}）
          </p>
          <p className="cb-import-done__banner-sub">生成了一份原始数据，下一步从中提取能力项</p>
        </div>
        <button type="button" className="cb-link cb-import-done__reimport" onClick={onReimport}>
          重新导入
        </button>
      </div>

      {/* 2. 统计四格（真实值）。 */}
      <dl className="cb-import-done__stats">
        <div className="cb-import-done__stat">
          <dt className="cb-import-done__stat-label">会话段</dt>
          <dd className="cb-import-done__stat-value">{fmt(stats.segmentCount)}</dd>
        </div>
        <div className="cb-import-done__stat">
          <dt className="cb-import-done__stat-label">消息条数</dt>
          <dd className="cb-import-done__stat-value">{fmt(stats.messageCount)}</dd>
        </div>
        <div className="cb-import-done__stat">
          <dt className="cb-import-done__stat-label">时间跨度</dt>
          <dd className="cb-import-done__stat-value">{timeSpanText(snapshot)}</dd>
        </div>
        <div className="cb-import-done__stat">
          <dt className="cb-import-done__stat-label">涉及项目</dt>
          <dd className="cb-import-done__stat-value">{fmt(stats.projectCount)}</dd>
        </div>
      </dl>

      {/* 3. 原始会话列表（只读，去敏后标题）。 */}
      <div className="cb-import-done__segments" aria-label="原始会话（只读）">
        <p className="cb-import-done__segments-title">原始会话（只读）</p>
        <ul className="cb-import-done__seg-list">
          {segments.map((seg) => (
            <li key={seg.segmentId} className="cb-import-done__seg">
              <span className="cb-import-done__seg-date">{seg.dateLabel}</span>
              <span className="cb-import-done__seg-title">{seg.title}</span>
              {seg.project && <span className="cb-import-done__seg-project">{seg.project}</span>}
              <span className="cb-import-done__seg-count">{seg.messageCount} 条</span>
            </li>
          ))}
          {segments.length === 0 && (
            <li className="cb-import-done__seg-empty">这次没有可展示的会话节选。</li>
          )}
        </ul>
      </div>
    </section>
  );
}
