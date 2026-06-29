// 封面来源选择（F-14，§5.5）——封面图标三种来源（发布-11/12/13/32）。
//
// 三来源（CoverSource，50 §2.1）：
//   - glyph：根据产物类型自动生成的字形图标（无需额外，发布-12 / 默认 发布-25）。【本期唯一可用】
//   - image：创作者用 AI 生成或自己上传的图片（CoverInput.assetKey，预签名直传后回填）。
//   - html_snapshot：用 HTML 渲染一张产物快照（CoverInput.snapshotRef，异步渲染产物快照，发布-32）。
//
// 半成品诚实化（P1-6 / Codex#r1）：image / html_snapshot 的资产链路（上传直传 / 快照渲染）本期未落，
//   选了它们也凑不齐 assetKey / snapshotRef，发出去就是半成品 cover input。故本组件【直接禁用】这两项
//   （disabled 占位、不可选中），只放 glyph 可用——绝不让创作者切到一个发不出完整封面的来源。
//   待上传 / 快照渲染链路补齐（assetKey / snapshotRef 回填）后，再把对应项 enabled。
import type { ReactElement } from 'react';
import type { CoverSource } from '@cb/shared';

const COVER_OPTIONS: ReadonlyArray<{
  source: CoverSource;
  label: string;
  hint: string;
  /** 本期是否可用：false = disabled 占位（资产链路未落，发出去会是半成品，P1-6）。 */
  available: boolean;
}> = [
  {
    source: 'glyph',
    label: '字形图标',
    hint: '按产物类型自动生成，无需额外操作。',
    available: true,
  },
  {
    source: 'image',
    label: 'AI 生成 / 上传图片',
    hint: '上传链路本期未开放，先用字形图标。',
    available: false,
  },
  {
    source: 'html_snapshot',
    label: 'HTML 产物快照',
    hint: '快照渲染本期未开放，先用字形图标。',
    available: false,
  },
];

export interface CoverPickerProps {
  source: CoverSource;
  onChange: (source: CoverSource) => void;
}

export function CoverPicker({ source, onChange }: CoverPickerProps): ReactElement {
  return (
    <fieldset className="cb-cover-picker">
      <legend className="cb-cover-picker__legend">封面来源</legend>
      <div className="cb-cover-picker__options" role="radiogroup" aria-label="选择封面来源">
        {COVER_OPTIONS.map((opt) => {
          const checked = opt.source === source;
          const disabled = !opt.available;
          return (
            <button
              key={opt.source}
              type="button"
              className="cb-cover-picker__option"
              role="radio"
              aria-checked={checked}
              aria-disabled={disabled || undefined}
              disabled={disabled}
              data-source={opt.source}
              data-selected={checked ? 'true' : 'false'}
              data-available={opt.available ? 'true' : 'false'}
              // 未落资产链路的来源不可选中——绝不切到一个凑不齐 assetKey/snapshotRef 的来源（P1-6）。
              onClick={() => {
                if (opt.available) onChange(opt.source);
              }}
            >
              <span className="cb-cover-picker__radio" aria-hidden="true">
                {checked ? '●' : '○'}
              </span>
              <span className="cb-cover-picker__label">{opt.label}</span>
              <span className="cb-cover-picker__hint">{opt.hint}</span>
              {disabled && (
                <span className="cb-cover-picker__badge" aria-hidden="true">
                  本期未开放
                </span>
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
