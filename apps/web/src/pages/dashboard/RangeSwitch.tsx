// 时间范围切换（外壳首页-19）——近7 / 近30 / 全部，当前档有选中标识。
//
// 受控段控（segmented）：value + onChange，与 TokenTrendChart 的 MetricToggle 同风格。
// 切换三档不报错；各端点 query key 含 range，切档自动重取（局部刷新，不整页崩）。
import type { ReactElement } from 'react';
import type { Range } from '@cb/shared';

export interface RangeSwitchProps {
  value: Range;
  onChange: (range: Range) => void;
}

const RANGE_OPTIONS: ReadonlyArray<{ key: Range; label: string }> = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' },
];

export function RangeSwitch({ value, onChange }: RangeSwitchProps): ReactElement {
  return (
    <div className="cb-range-switch" role="group" aria-label="切换时间范围">
      {RANGE_OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`cb-range-switch__btn${
            value === o.key ? ' cb-range-switch__btn--active' : ''
          }`}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
