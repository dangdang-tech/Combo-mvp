// 草稿与上传中条（外壳首页-16/17/23/33/34，F-15）。
//
// Figma：暖米单 bar，左 mono 标签「草稿与上传中」+ 中胶囊行（状态点 + 名 + 进度短语）+ 右单个「去上传流程 →」。
// 每个胶囊可点，各回各的精确断点（currentStep → 五步路由，不串台，外壳首页-34）；右侧 CTA 回首条草稿断点。
// 进度/步骤由后端 DraftView 单源（currentStep + stepProgress.phrase），前端不另算。
// 空态（外壳首页-23）：无 active 草稿 → 整条不渲染。
import type { ReactElement } from 'react';
import type { DraftView, DraftStep } from '@cb/shared';
import { CREATE_STEPS } from '../../shell/routes.js';

export interface DraftStripProps {
  drafts: DraftView[];
  /** 点胶囊或 CTA → 跳到该草稿 currentStep 对应路由（精确断点恢复）。 */
  onResume: (draft: DraftView, path: string) => void;
}

/** currentStep → 五步路由（CREATE_STEPS 单源；缺映射兜底进第一步）。 */
function pathForStep(step: DraftStep): string {
  return (
    CREATE_STEPS.find((s) => s.step === step)?.path ?? CREATE_STEPS[0]?.path ?? '/create/import'
  );
}

function DraftChip({
  draft,
  onResume,
}: {
  draft: DraftView;
  onResume: (draft: DraftView, path: string) => void;
}): ReactElement {
  const path = pathForStep(draft.currentStep);
  const name = draft.title ?? '未命名草稿';
  return (
    <button
      type="button"
      className="cb-draft-chip"
      data-draft={draft.id}
      data-step={draft.currentStep}
      onClick={() => onResume(draft, path)}
      title={`恢复：${name} · ${draft.stepProgress.phrase}`}
    >
      <span className="cb-draft-chip__dot" aria-hidden="true" />
      <span className="cb-draft-chip__name">{name}</span>
      <span className="cb-draft-chip__phrase">· {draft.stepProgress.phrase}</span>
    </button>
  );
}

export function DraftStrip({ drafts, onResume }: DraftStripProps): ReactElement | null {
  // 空态：无草稿整条不渲染（外壳首页-23）。
  if (drafts.length === 0) return null;
  const first = drafts[0]!;
  return (
    <section className="cb-draft-strip" aria-label="草稿与上传中">
      <span className="cb-draft-strip__label">草稿与上传中</span>
      <div className="cb-draft-strip__chips">
        {drafts.map((d) => (
          <DraftChip key={d.id} draft={d} onResume={onResume} />
        ))}
      </div>
      <button
        type="button"
        className="cb-draft-strip__cta"
        onClick={() => onResume(first, pathForStep(first.currentStep))}
      >
        去上传流程 →
      </button>
    </section>
  );
}
