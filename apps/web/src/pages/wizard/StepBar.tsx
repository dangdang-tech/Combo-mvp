// 步骤条（F-09，开工总纲 §5.0）——五段常驻内容区顶部，四态语义。
//
// 状态语义（§5.0）：
//   - done    已完成：显对勾 ✓，可点回看（贯穿-16）。
//   - current 进行中：高亮、aria-current="step"，不可点自身。
//   - todo    待办：显序号数字（§5.0「待办显数字」），不可点（还没到）。
//   - error   异常：标红 ✕，可点进去重试（带退路）。
// 渲染真源全来自 buildStepNodes（wizardMachine），本组件不自算状态。
import type { ReactElement } from 'react';
import type { DraftStep } from '@cb/shared';
import type { StepNodeView, StepStatus } from './wizardMachine.js';

/** 各态步骤条记号（done 对勾 / error ✕ / 其余显序号，§5.0 待办显数字）。 */
function stepMark(node: StepNodeView): string {
  if (node.status === 'done') return '✓';
  if (node.status === 'error') return '✕';
  return String(node.index); // current / todo 均显数字（待办显数字、进行中也带号便于定位）。
}

const STATUS_TEXT: Record<StepStatus, string> = {
  done: '已完成',
  current: '进行中',
  todo: '待办',
  error: '异常',
};

export interface StepBarProps {
  nodes: StepNodeView[];
  /** 点已完成 / 异常步回看 / 重试（贯穿-16）。todo/current 不触发。 */
  onNavigate: (step: DraftStep) => void;
}

export function StepBar({ nodes, onNavigate }: StepBarProps): ReactElement {
  return (
    <ol className="cb-stepbar" aria-label="上传五步进度">
      {nodes.map((node) => {
        const ariaLabel = `第 ${node.index} 步：${node.label}（${STATUS_TEXT[node.status]}）`;
        const inner = (
          <>
            <span className="cb-stepbar__mark" aria-hidden="true">
              {stepMark(node)}
            </span>
            <span className="cb-stepbar__label">{node.label}</span>
            <span className="cb-stepbar__status" aria-hidden="true">
              {STATUS_TEXT[node.status]}
            </span>
          </>
        );
        return (
          <li
            key={node.step}
            className="cb-stepbar__seg"
            data-step={node.step}
            data-status={node.status}
            {...(node.status === 'current' ? { 'aria-current': 'step' as const } : {})}
          >
            {node.navigable ? (
              // 已完成 / 异常步：可点回看或重试（带退路，§八②）。
              <button
                type="button"
                className="cb-stepbar__btn"
                onClick={() => onNavigate(node.step)}
                aria-label={`${ariaLabel}，点击回看`}
              >
                {inner}
              </button>
            ) : (
              // 进行中 / 待办：不可点（待办还没到，进行中即当前页）。
              <span className="cb-stepbar__btn cb-stepbar__btn--static" aria-label={ariaLabel}>
                {inner}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
