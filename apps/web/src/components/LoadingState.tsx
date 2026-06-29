// LoadingState / Skeleton（F-03，硬规则「永不裸转圈」）——统一加载态约定。
//
// 三件套，对应脊柱 §7「永不裸转圈」：
//   1. ProgressBar      —— 总进度 + 量化文案（「68% · 已抓取 146 / 215 段」）。
//   2. SubtaskChecklist —— 子任务清单逐条点亮（pending/running/done/failed）。
//   3. Skeleton         —— 边生成边显示的占位骨架（无进度可报时也给结构，不给空白转圈）。
import type { ReactElement } from 'react';
import type { ProgressView, SubtaskView } from '@cb/shared';

/** 总进度条 + 量化文案。slow=true 时附「仍在处理」安抚。 */
export function ProgressBar({ progress }: { progress: ProgressView }): ReactElement {
  const pct = Math.min(100, Math.max(0, progress.percent));
  return (
    <div className="cb-progress" aria-live="polite">
      <div
        className="cb-progress__track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="cb-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="cb-progress__phrase">{progress.phrase}</p>
      {progress.slow && <p className="cb-progress__slow">仍在处理，请稍候…</p>}
    </div>
  );
}

const SUBTASK_MARK: Record<SubtaskView['status'], string> = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✕',
};

/** 子任务清单：逐条点亮，让等待「有结构」。 */
export function SubtaskChecklist({ subtasks }: { subtasks: SubtaskView[] }): ReactElement {
  return (
    <ul className="cb-subtasks">
      {subtasks.map((s) => (
        <li key={s.key} className="cb-subtasks__item" data-status={s.status}>
          <span className="cb-subtasks__mark" aria-hidden>
            {SUBTASK_MARK[s.status]}
          </span>
          <span className="cb-subtasks__label">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** 占位骨架：无进度可报时给结构化占位（行数可配），绝不空白裸转圈。 */
export function Skeleton({ rows = 3, label }: { rows?: number; label?: string }): ReactElement {
  return (
    <div className="cb-skeleton" role="status" aria-busy="true" aria-label={label ?? '加载中'}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="cb-skeleton__row" />
      ))}
    </div>
  );
}

export interface LoadingStateProps {
  /** 有 progress 则渲染进度条 + 子任务清单；否则退化为骨架。 */
  progress?: ProgressView;
  /** 无进度时骨架行数。 */
  skeletonRows?: number;
  /** 文案标签。 */
  label?: string;
}

/**
 * 统一加载态：能拿到 ProgressView 就显示「进度 + 子任务清单」，拿不到就显示骨架。
 * 任何时候都不要直接渲染裸 spinner——这是组件层的硬约定。
 */
export function LoadingState({ progress, skeletonRows, label }: LoadingStateProps): ReactElement {
  if (progress) {
    return (
      <div className="cb-loading">
        <ProgressBar progress={progress} />
        {progress.subtasks.length > 0 && <SubtaskChecklist subtasks={progress.subtasks} />}
      </div>
    );
  }
  return (
    <Skeleton
      {...(skeletonRows !== undefined ? { rows: skeletonRows } : {})}
      {...(label !== undefined ? { label } : {})}
    />
  );
}
