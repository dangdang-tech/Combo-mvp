// SlowHint / FieldStuck 三退路提示（脊柱 §5.3 / §7「永不裸转圈」收尾件）。
//
// 两种「慢但没坏」的安抚 + 退路，二者都不是错误（绝不走 ErrorState）：
//   - slow_hint：整体慢提示（只一句安抚文案 + elapsed），可附「继续等 / 不等了」。
//   - field_stuck：某字段卡住，后端给三选项 ∈ {continue, regen, wait}，前端逐个渲染为退路按钮。
//
// 任何一种都让等待「有出口」，而非裸转圈干等。文案中文人话，不露 code/字段英文键名给用户当主文案。
import type { ReactElement } from 'react';
import type { SlowHintPayload, FieldStuckPayload } from '@cb/shared';

/** field_stuck 三退路的人话标签。 */
const STUCK_OPTION_LABEL: Record<FieldStuckPayload['options'][number], string> = {
  // continue 实为「停流、用已生成部分先继续，卡住字段留待手动填」（§3.3 / StructureStepPage setReleased），
  // 不是「让模型接着生成」——文案与该语义对齐，避免误导用户选错退路（绝不裸露误导文案）。
  continue: '继续用已生成',
  regen: '重新生成',
  wait: '再等等',
};

export interface SlowHintProps {
  /** slow_hint 帧 payload（整体慢）。 */
  slowHint?: SlowHintPayload | undefined;
  /** field_stuck 帧 payload（字段卡住，带三退路选项）。 */
  stuck?: FieldStuckPayload | undefined;
  /** 字段卡住时点某退路的回调（传入被选 option）。 */
  onStuckChoice?: (option: FieldStuckPayload['options'][number]) => void;
}

/** 把毫秒转成「约 X 秒/分」的得体短语（不暴露精确数字给用户当压力）。 */
function elapsedPhrase(ms: number): string {
  if (ms < 60_000) return `已等待约 ${Math.max(1, Math.round(ms / 1000))} 秒`;
  return `已等待约 ${Math.round(ms / 60_000)} 分钟`;
}

/**
 * 慢提示 / 卡住退路。无 slowHint 且无 stuck 时不渲染（返回空 fragment）。
 * 永不裸转圈：哪怕只是「慢」，也给一句安抚 + 可选退路，让用户知道系统活着、且有出口。
 */
export function SlowHint({ slowHint, stuck, onStuckChoice }: SlowHintProps): ReactElement | null {
  if (!slowHint && !stuck) return null;

  return (
    <div className="cb-slowhint" role="status" aria-live="polite">
      {stuck ? (
        <>
          <p className="cb-slowhint__phrase">
            这一项生成得有点慢，{elapsedPhrase(stuck.elapsedMs)}。
          </p>
          <div className="cb-slowhint__actions">
            {stuck.options.map((opt) => (
              <button
                key={opt}
                type="button"
                className="cb-slowhint__action"
                data-option={opt}
                onClick={() => onStuckChoice?.(opt)}
              >
                {STUCK_OPTION_LABEL[opt]}
              </button>
            ))}
          </div>
        </>
      ) : slowHint ? (
        <p className="cb-slowhint__phrase">
          {slowHint.phrase}
          <span className="cb-slowhint__elapsed">（{elapsedPhrase(slowHint.elapsedMs)}）</span>
        </p>
      ) : null}
    </div>
  );
}
