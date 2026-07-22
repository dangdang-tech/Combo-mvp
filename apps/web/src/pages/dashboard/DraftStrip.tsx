// 进行中的创作条（外壳首页-16/17/23/33/34，F-15）。
//
// 冷纸单 bar：左侧说明这是可恢复的创作，中间逐项展示当前阶段，右侧动作跟随首项所处阶段。
// 每个胶囊可点，各回各的精确断点（currentStep → 当前两页创作路由，不串台）；右侧 CTA 回首条草稿断点。
// 阶段由后端 currentStep 单源；实时进度沿用 stepProgress.phrase，前端只补用户可理解的阶段名称与动作名称。
// 空态（外壳首页-23）：无 active 草稿 → 整条不渲染。
import type { ReactElement } from 'react';
import type { DraftView, DraftStep } from '@cb/shared';

export interface DraftStripProps {
  drafts: DraftView[];
  /** 点胶囊或 CTA → 跳到该草稿 currentStep 对应路由（精确断点恢复）。 */
  onResume: (draft: DraftView, path: string) => void;
}

/**
 * currentStep → 上传路由（PRD 2 步：上传 / 能力页）。
 * 后端 DraftView.currentStep 仍是原脊柱枚举（import/extract/select/structure/publish）；前端已坍缩为 2 步：
 *   still-import → /create/import；已过导入（extract 及之后）→ 能力页续断点（提取过程态 / 候选卡 / 发布都在此页）。
 */
function pathForStep(step: DraftStep): string {
  return step === 'import' ? '/create/import' : '/create/capabilities';
}

const STEP_COPY: Record<DraftStep, { stage: string; action: string }> = {
  import: { stage: '正在导入会话', action: '继续导入' },
  extract: { stage: '正在分析工作历史', action: '查看分析进度' },
  select: { stage: 'Agent 已准备好', action: '查看 Agent' },
  structure: { stage: '正在完善 Agent', action: '继续完善' },
  publish: { stage: '等待发布', action: '继续发布' },
};

function copyForDraft(draft: DraftView): { stage: string; action: string } {
  // worker 会在提取成功时把真实终态写回 stepProgress；currentStep 仍保留 extract，
  // 因为 select 代表用户已经选定候选，不能用后台完成冒充用户选择。
  if (draft.currentStep === 'extract' && draft.stepProgress.percent >= 100) {
    return { stage: '识别已完成', action: '查看识别结果' };
  }
  return STEP_COPY[draft.currentStep];
}

function progressForDraft(draft: DraftView): string {
  const { stage } = copyForDraft(draft);
  const progress = draft.stepProgress.phrase.trim();
  return progress.length > 0 ? `${stage} · ${progress}` : stage;
}

function nameForDraft(draft: DraftView): string {
  const explicit = draft.title?.trim();
  if (explicit) return explicit;
  const updatedAt = new Date(draft.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return '新的 Agent 创作';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(updatedAt);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `Agent 创作 · ${value('month')}/${value('day')} ${value('hour')}:${value('minute')}`;
}

function DraftChip({
  draft,
  onResume,
}: {
  draft: DraftView;
  onResume: (draft: DraftView, path: string) => void;
}): ReactElement {
  const path = pathForStep(draft.currentStep);
  const name = nameForDraft(draft);
  const copy = copyForDraft(draft);
  const progress = progressForDraft(draft);
  return (
    <button
      type="button"
      className="cb-draft-chip"
      data-draft={draft.id}
      data-step={draft.currentStep}
      onClick={() => onResume(draft, path)}
      aria-label={`${copy.action}：${name}，${progress}`}
      title={`${copy.action}：${name} · ${progress}`}
    >
      <span className="cb-draft-chip__dot" aria-hidden="true" />
      <span className="cb-draft-chip__name">{name}</span>
      <span className="cb-draft-chip__phrase">· {progress}</span>
    </button>
  );
}

export function DraftStrip({ drafts, onResume }: DraftStripProps): ReactElement | null {
  // API 契约外的残缺行不应拖垮整个管理页；只有具备阶段与进度的活动草稿才进入恢复入口。
  const resumableDrafts = drafts.filter(
    (draft) =>
      Boolean(STEP_COPY[draft.currentStep]) &&
      typeof draft.stepProgress?.phrase === 'string' &&
      !(
        draft.currentStep === 'publish' &&
        draft.stepProgress.percent >= 100 &&
        draft.stepProgress.phrase.trim() === '发布完成'
      ),
  );
  // 空态：无草稿整条不渲染（外壳首页-23）。
  if (resumableDrafts.length === 0) return null;
  const first = resumableDrafts[0]!;
  const firstAction = copyForDraft(first).action;
  return (
    <section className="cb-draft-strip" aria-label="进行中的创作">
      <span className="cb-draft-strip__label">进行中的创作</span>
      <div className="cb-draft-strip__chips">
        {resumableDrafts.map((d) => (
          <DraftChip key={d.id} draft={d} onResume={onResume} />
        ))}
      </div>
      <button
        type="button"
        className="cb-draft-strip__cta"
        onClick={() => onResume(first, pathForStep(first.currentStep))}
      >
        {firstAction} →
      </button>
    </section>
  );
}
