// STEP④ App Identity 面板（F-13，§5.4）——右侧当前能力的软硬两组，一眼区分。
//
// 结构（自上而下）：
//   1. 整体生成进度短语「已补全字段 N / 7」（永不裸转圈的量化文案；全 done 后不显）。
//   2. 软组（经验体生成，可改 / 可重生成）：7 个 SoftFieldCard，逐字段流式（generating 骨架 / done 终值 / failed 错误态）。
//   3. 三退路（field_stuck）：某软字段卡住时 SlowHint 给「继续用已生成 / 只重生成卡住字段 / 再等等」（绝不裸转圈）。
//   4. 硬组（平台固定契约，锁定）：6 个 HardFieldCard，恒锁定、无操作。
import type { ReactElement } from 'react';
import type { FieldStuckPayload, SlowHintPayload, SoftFieldKey } from '@cb/shared';
import { SlowHint } from '../../../components/index.js';
import type { SoftFieldView, HardFieldView } from './manifestFields.js';
import { softProgressText, isDone, isGenerating } from './manifestFields.js';
import { SoftFieldCard } from './SoftFieldCard.js';
import { HardFieldCard } from './HardFieldCard.js';

export interface AppIdentityPanelProps {
  /** 当前能力名称（左侧切换列表里选中的；用于面板标题）。 */
  capabilityName: string;
  soft: SoftFieldView[];
  hard: HardFieldView[];
  /** field_stuck（三退路）/ slow_hint（整体慢）——SSE 透传，永不裸转圈。 */
  stuck?: FieldStuckPayload | undefined;
  slowHint?: SlowHintPayload | undefined;
  /** 保存某软字段编辑（PATCH manifest 单字段）。 */
  onSaveField: (field: SoftFieldKey, value: string | string[]) => void;
  /** 重新生成某软字段（regen，reason=manual；不丢其它）。 */
  onRegenerateField: (field: SoftFieldKey) => void;
  /** failed 态重试某软字段（regen，reason=manual；累计 2 次转人工）。 */
  onRetryField: (field: SoftFieldKey) => void;
  /** field_stuck 三退路选择（continue=前端放行 / regen=只重生成卡住字段 / wait=继续等）。 */
  onStuckChoice: (option: FieldStuckPayload['options'][number]) => void;
  /** 哪些软字段正在重生成在途（禁用其按钮）。 */
  busyFields?: ReadonlySet<SoftFieldKey>;
}

export function AppIdentityPanel({
  capabilityName,
  soft,
  hard,
  stuck,
  slowHint,
  onSaveField,
  onRegenerateField,
  onRetryField,
  onStuckChoice,
  busyFields,
}: AppIdentityPanelProps): ReactElement {
  const allDone = soft.every((s) => isDone(s.status));
  // 仍有字段在生成（永不裸转圈：禁用发布按钮时给明确「正在生成、可等」短语，而非只剩静态计数，BUG-016/STEP4）。
  const anyGenerating = soft.some((s) => isGenerating(s.status));

  return (
    <section className="cb-app-identity" aria-label={`${capabilityName} 的 App Identity`}>
      <header className="cb-app-identity__head">
        <h2 className="cb-app-identity__title">{capabilityName}</h2>
        {!allDone && (
          <p className="cb-app-identity__progress" role="status" aria-live="polite">
            {softProgressText(soft)}
            {anyGenerating && (
              <span className="cb-app-identity__progress-hint">
                {' '}
                · 剩余字段正在生成，完成后即可进入发布；可以稍等，或先编辑已生成的字段。
              </span>
            )}
          </p>
        )}
      </header>

      {/* 软组：经验体生成（可改 / 可重生成），逐字段流式。 */}
      <div className="cb-app-identity__group cb-app-identity__group--soft">
        <h3 className="cb-app-identity__group-title">软字段 · 经验体生成（可改 / 可重生成）</h3>
        <div className="cb-app-identity__fields">
          {soft.map((s) => (
            <SoftFieldCard
              key={s.field}
              view={s}
              onSave={(value) => onSaveField(s.field, value)}
              onRegenerate={() => onRegenerateField(s.field)}
              onRetry={() => onRetryField(s.field)}
              busy={busyFields?.has(s.field) ?? false}
            />
          ))}
        </div>
      </div>

      {/* 三退路：某软字段卡住 / 整体慢（绝不裸转圈，验收 选择结构化-15~18）。 */}
      <SlowHint stuck={stuck} slowHint={slowHint} onStuckChoice={onStuckChoice} />

      {/* 硬组：平台固定契约（锁定），恒只读。 */}
      <div className="cb-app-identity__group cb-app-identity__group--hard">
        <h3 className="cb-app-identity__group-title">硬字段 · 平台固定契约（锁定）</h3>
        <div className="cb-app-identity__fields">
          {hard.map((h) => (
            <HardFieldCard key={h.field} view={h} />
          ))}
        </div>
      </div>
    </section>
  );
}
