// 页头摘要（外壳首页-08）——固定标题 +「一句话经营摘要」+ 右上「上传新能力」主按钮。
//
// 摘要句由后端 summaryTemplate 提供（含 {publishedCount}/{monthlyInvocations} 占位符），
// 前端代入：publishedCount 真实；monthlyInvocations 为 usage 占位 → 用得体占位文案代入（决策②），
// 绝不代入 0 / "null"（不误导成「真有 0 次调用」）。摘要数字与指标卡同源（同一 range 的两个端点）。
import type { ReactElement } from 'react';
import type { DashboardSummary, Meta } from '@cb/shared';
import { isPlaceholder, placeholderText } from '../../components/index.js';

export interface SummaryHeaderProps {
  /** summary 端点数据；null = 加载中（由上层决定渲染骨架，这里只在拿到数据后用）。 */
  summary: DashboardSummary;
  meta: Meta | undefined;
  /** 「+ 上传新能力」主按钮（进五步上传流程）。 */
  onCreate: () => void;
}

/** usage 占位字段键（与 60 域契约一致）。 */
const MONTHLY_FIELD = 'monthlyInvocations';

/**
 * 代入摘要句：把模板里的 {publishedCount} 换真实值；{monthlyInvocations} 换占位文案或真实值。
 *   monthlyInvocations 为 null 且 meta 标注占位 → 用占位文案（如「暂无数据 / 上线后填充」），
 *   不代入 0/null。后端给真值（上线后）则代入真值 + 「次」。
 */
export function renderSummarySentence(summary: DashboardSummary, meta: Meta | undefined): string {
  const monthly =
    summary.monthlyInvocations !== null
      ? String(summary.monthlyInvocations)
      : placeholderText(meta, MONTHLY_FIELD);
  return summary.summaryTemplate
    .replaceAll('{publishedCount}', String(summary.publishedCount))
    .replaceAll('{monthlyInvocations}', monthly);
}

export function SummaryHeader({ summary, meta, onCreate }: SummaryHeaderProps): ReactElement {
  const monthlyIsPlaceholder =
    summary.monthlyInvocations === null && isPlaceholder(meta, MONTHLY_FIELD);
  return (
    <header className="cb-dash-header">
      <div className="cb-dash-header__text">
        <h2 className="cb-dash-header__title">{summary.title}</h2>
        <p
          className="cb-dash-header__summary"
          data-monthly-placeholder={monthlyIsPlaceholder ? 'true' : 'false'}
        >
          {renderSummarySentence(summary, meta)}
        </p>
      </div>
      <button
        type="button"
        className="cb-btn cb-btn--primary cb-dash-header__create"
        onClick={onCreate}
      >
        + 上传新能力
      </button>
    </header>
  );
}
