// SlowHint——「慢但没坏」的安抚（永不裸转圈的收尾件）：slow_hint 帧的文案 + 已等待时长。
// 它不是错误（绝不走 ErrorState），只让用户知道系统活着。
import type { ReactElement } from 'react';
import type { SlowHintPayload } from '@cb/shared';

export interface SlowHintProps {
  slowHint?: SlowHintPayload | undefined;
}

/** 把毫秒转成「约 X 秒/分」的得体短语。 */
function elapsedPhrase(ms: number): string {
  if (ms < 60_000) return `已等待约 ${Math.max(1, Math.round(ms / 1000))} 秒`;
  return `已等待约 ${Math.round(ms / 60_000)} 分钟`;
}

/** 无 slowHint 时不渲染。 */
export function SlowHint({ slowHint }: SlowHintProps): ReactElement | null {
  if (!slowHint) return null;
  return (
    <div className="cb-slowhint" role="status" aria-live="polite">
      <p className="cb-slowhint__phrase">
        {slowHint.phrase}
        <span className="cb-slowhint__elapsed">（{elapsedPhrase(slowHint.elapsedMs)}）</span>
      </p>
    </div>
  );
}
