import type { ReactElement } from 'react';

export type CreationJourneyStepState = 'done' | 'active' | 'pending';

export interface CreationJourneySnapshot {
  pathname: string;
  snapshotId?: string | undefined;
  extractJobId?: string | undefined;
  versionId?: string | undefined;
  capabilityId?: string | undefined;
  batchId?: string | undefined;
  hasAgentReady?: boolean | undefined;
  hasTrialResult?: boolean | undefined;
  publishCompleted?: boolean | undefined;
}

export interface CreationJourneyProps extends CreationJourneySnapshot {
  draftId?: string | undefined;
}

interface JourneyStep {
  label: string;
  state: CreationJourneyStepState;
}

const STEP_LABELS = ['导入工作历史', '识别 Agent', '生成页面', '修改与发布'] as const;

/**
 * 只用已经落库或已经进入当前路由的事实推进旅程，不用假进度安抚用户。
 * extractJobId 只能证明识别任务已开始；version/capability 只能证明页面开始生成；真实试用回流后才进入修改发布。
 */
export function deriveCreationJourney(snapshot: CreationJourneySnapshot): JourneyStep[] {
  const hasPublishedResult = Boolean(snapshot.publishCompleted);
  const hasTrialResult = Boolean(
    snapshot.hasTrialResult || snapshot.batchId || hasPublishedResult,
  );
  const hasRunnableVersion = Boolean(
    snapshot.hasAgentReady || snapshot.versionId || snapshot.capabilityId || hasTrialResult,
  );
  const hasImportResult = Boolean(
    snapshot.snapshotId || snapshot.extractJobId || hasRunnableVersion,
  );

  if (hasPublishedResult) {
    return STEP_LABELS.map((label) => ({ label, state: 'done' }));
  }

  if (hasTrialResult) {
    return STEP_LABELS.map((label, index) => ({
      label,
      state: index < 3 ? 'done' : 'active',
    }));
  }

  if (hasRunnableVersion) {
    return STEP_LABELS.map((label, index) => ({
      label,
      state: index < 2 ? 'done' : index === 2 ? 'active' : 'pending',
    }));
  }

  if (hasImportResult) {
    return STEP_LABELS.map((label, index) => ({
      label,
      state: index === 0 ? 'done' : index === 1 ? 'active' : 'pending',
    }));
  }

  return STEP_LABELS.map((label, index) => ({
    label,
    state: index === 0 ? 'active' : 'pending',
  }));
}

function stepAriaLabel(step: JourneyStep): string {
  if (step.state === 'done') return `已完成：${step.label}`;
  if (step.state === 'active') return `当前阶段：${step.label}`;
  return `待进行：${step.label}`;
}

/**
 * 上传和 Agent 结果页共用的紧凑创作身份。它只负责告诉用户「仍在同一个项目里」以及系统当前走到哪，
 * 不承担导航，也不要求用户逐步做决定。
 */
export function CreationJourney({
  pathname,
  draftId,
  snapshotId,
  extractJobId,
  versionId,
  capabilityId,
  batchId,
  hasAgentReady,
  hasTrialResult,
  publishCompleted,
}: CreationJourneyProps): ReactElement {
  const steps = deriveCreationJourney({
    pathname,
    snapshotId,
    extractJobId,
    versionId,
    capabilityId,
    batchId,
    hasAgentReady,
    hasTrialResult,
    publishCompleted,
  });

  return (
    <section
      className="cb-capabilities cb-creation-journey"
      aria-labelledby="cb-creation-journey-title"
      data-project={draftId ?? 'new'}
    >
      <header className="cb-cmdbox__header">
        <div>
          <p className="cb-cmdbox__eyebrow">Agent 创作项目</p>
          <p className="cb-cmdbox__title" id="cb-creation-journey-title">
            从工作历史生成 Agent
          </p>
        </div>
        <span className="cb-cap-status" data-tone={draftId ? 'ok' : 'neutral'}>
          {draftId ? '项目已建立' : '正在建立项目'}
        </span>
      </header>

      <ol className="cb-agent-result__flow" aria-label="Agent 创作旅程">
        {steps.map((step, index) => (
          <li
            key={step.label}
            data-state={step.state}
            aria-current={step.state === 'active' ? 'step' : undefined}
            aria-label={stepAriaLabel(step)}
          >
            <span aria-hidden="true">{index + 1}</span>
            {step.label}
          </li>
        ))}
      </ol>
    </section>
  );
}
