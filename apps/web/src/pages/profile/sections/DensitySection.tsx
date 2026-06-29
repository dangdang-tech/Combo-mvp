// ③ 能力·按会话密度（主页-05/06/07/08）——密度条（4A DensityBar）+ 支撑会话段数 + 趋势箭头，
// 逐条可下钻，默认前 3 + 「展开更多」。
//
// 真实数据（densityScore/supportingSegments/trend，不依赖 usage）。
// 渲染分两层：① 4A DensityBar 给可视密度条（观感统一）；② 无障碍行列表给逐条段数/趋势/下钻入口
//   （ECharts canvas 在 jsdom 不可断言，行列表是可测+可访问的主交互层）。
// 只读无管理（主页-08）：readonly:true，逐条「下钻」只是「看更细密度构成」的查看（主页-07，P1 占位），
//   绝不出现发布/编辑/下架/改价等管理动作。
import type { ReactElement } from 'react';
import type { ProfileDensitySlice, DensityRankRow } from '@cb/shared';
import { DensityBar, TREND_ARROW } from '../../../components/index.js';

export interface DensitySectionProps {
  density: ProfileDensitySlice;
  loadingMore: boolean;
  onLoadMore: () => void;
}

const TREND_LABEL: Record<DensityRankRow['trend'], string> = {
  up: '上升',
  down: '下降',
  flat: '持平',
};

/** 下钻占位徽标文案（主页-07 密度构成详情为 P1，本期未开放；点了有可见反馈，非空 preventDefault）。 */
const DRILL_PENDING_HINT = '密度构成详情本期未开放';

function DensityRow({ row }: { row: DensityRankRow }): ReactElement {
  return (
    <li className="cb-density-row" data-rank={row.rank}>
      {/* 逐条下钻：查看更细密度构成（主页-07，P1）。详情视图本期未上线 → 明确 disabled 占位，
          点击有可见反馈（徽标「本期未开放」），绝不空 preventDefault 让用户点了无反应（Codex r1#4）。
          只读查看语义，绝非管理动作（主页-08）。 */}
      <button
        type="button"
        className="cb-density-row__drill"
        disabled
        aria-disabled="true"
        title={DRILL_PENDING_HINT}
      >
        <span className="cb-density-row__rank">{row.rank}</span>
        <span className="cb-density-row__name">{row.name}</span>
        <span className="cb-density-row__segments">{row.supportingSegments} 段支撑</span>
        <span
          className="cb-density-row__trend"
          data-trend={row.trend}
          aria-label={`趋势${TREND_LABEL[row.trend]}`}
          title={TREND_LABEL[row.trend]}
        >
          {TREND_ARROW[row.trend]}
        </span>
        {/* 可见的「本期未开放」反馈：点了 disabled 按钮也有静态可见结果（非裸 preventDefault）。 */}
        <span className="cb-density-row__drill-pending" aria-label={DRILL_PENDING_HINT}>
          本期未开放
        </span>
      </button>
    </li>
  );
}

export function DensitySection({
  density,
  loadingMore,
  onLoadMore,
}: DensitySectionProps): ReactElement {
  if (density.rows.length === 0) {
    return (
      <section className="cb-profile-section cb-profile-density" aria-label="能力会话密度">
        <h2 className="cb-profile-section__title">能力 · 按会话密度</h2>
        <p className="cb-profile-density__empty">还没有能力</p>
      </section>
    );
  }
  return (
    <section className="cb-profile-section cb-profile-density" aria-label="能力会话密度">
      <h2 className="cb-profile-section__title">能力 · 按会话密度</h2>
      {/* 4A 密度条（可视层） */}
      <DensityBar rows={density.rows} />
      {/* 可测+可访问的逐条层（段数 / 趋势 / 下钻） */}
      <ul className="cb-density-list">
        {density.rows.map((row) => (
          <DensityRow key={row.capabilityId} row={row} />
        ))}
      </ul>
      {density.hasMore && (
        <button
          type="button"
          className="cb-profile-density__more"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? '加载中…' : '展开更多'}
        </button>
      )}
    </section>
  );
}
