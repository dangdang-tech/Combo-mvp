// STEP④ 硬字段卡（F-13，§5.4.2）——平台固定契约，锁定不可改、不参与生成、无加载条。
//
// 一眼区分软硬（验收 选择结构化-09/11/27）：硬字段卡带「平台锁定」徽章 + 锁图标，无编辑/重生成操作，
// 恒显终值（不显骨架、不报字段级失败）。值由 manifest 锁定字段直出（id/version/status/inputs/output/boundaries）。
import type { ReactElement } from 'react';
import type { HardFieldView } from './manifestFields.js';

export interface HardFieldCardProps {
  view: HardFieldView;
}

export function HardFieldCard({ view }: HardFieldCardProps): ReactElement {
  return (
    <div className="cb-hard-field" data-field={view.field} data-status="locked">
      <div className="cb-hard-field__head">
        <span className="cb-hard-field__label">{view.label}</span>
        <span className="cb-hard-field__badge cb-hard-field__badge--hard" aria-label="平台锁定">
          🔒 平台锁定
        </span>
      </div>
      <p className="cb-hard-field__value">{view.display}</p>
    </div>
  );
}
