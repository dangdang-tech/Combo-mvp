// StreamLoading（永不裸转圈 的「SSE 流 → 加载态」总装件）。
//
// 把 useSSE 的 UseSSEState 一站式翻成合规加载 UI，任何连接状态都给「有结构」的反馈：
//   - connecting：子任务清单/骨架（snapshot 已到则用 progress，否则骨架），不裸转圈。
//   - open：进度条 + 子任务清单 + slow_hint/field_stuck 三退路（边生成边显示由页面接 items）。
//   - reconnecting：保留上次进度 + 一行「连接断了，正在自动重连…」安抚条（非错误、非裸转圈）。
//   - error：交给 ErrorState（只 userMessage + action），不在本件渲染。
//   - done：本件不渲染加载（返回 null，由页面渲染结果）。
//
// 这是页面订阅 job/structure 流后最常用的加载外观；页面只需把 useSSE 返回值透传进来。
import type { ReactElement } from 'react';
import type { ProgressView } from '@cb/shared';
import type { UseSSEState } from '../api/useSSE.js';
import { LoadingState } from './LoadingState.js';
import { SlowHint } from './SlowHint.js';
import { ErrorState } from './ErrorState.js';
import type { FieldStuckPayload } from '@cb/shared';

export interface StreamLoadingProps {
  /** useSSE 返回的连接级状态。 */
  state: UseSSEState;
  /** 无 progress（结构化流或 snapshot 未到）时骨架行数。 */
  skeletonRows?: number;
  /** 加载文案标签。 */
  label?: string;
  /** error 态重试回调（透传 ErrorState）。 */
  onRetry?: () => void;
  /** field_stuck 三退路选择回调。 */
  onStuckChoice?: (option: FieldStuckPayload['options'][number]) => void;
}

/** 把 reconnecting 的「slow」软标记并进 progress，让进度条出现安抚条。 */
function withReconnectFlag(progress: ProgressView | undefined): ProgressView | undefined {
  if (!progress) return undefined;
  return { ...progress, slow: true };
}

/**
 * SSE 流加载总装：永不裸转圈。done 返回 null（结果由页面渲染）；error 渲染统一错误态。
 */
export function StreamLoading({
  state,
  skeletonRows,
  label,
  onRetry,
  onStuckChoice,
}: StreamLoadingProps): ReactElement | null {
  if (state.status === 'done') return null;

  if (state.status === 'error') {
    return <ErrorState error={state.error} {...(onRetry ? { onRetry } : {})} />;
  }

  const reconnecting = state.status === 'reconnecting';
  const progress = reconnecting ? withReconnectFlag(state.progress) : state.progress;

  return (
    <div className="cb-stream-loading" data-status={state.status}>
      {reconnecting && (
        <p className="cb-stream-loading__reconnect" role="status" aria-live="polite">
          连接断了，正在自动重连…（已生成的内容不会丢）
        </p>
      )}
      <LoadingState
        {...(progress ? { progress } : {})}
        {...(skeletonRows !== undefined ? { skeletonRows } : {})}
        {...(label !== undefined ? { label } : {})}
      />
      <SlowHint
        slowHint={state.slowHint}
        stuck={state.stuck}
        {...(onStuckChoice ? { onStuckChoice } : {})}
      />
    </div>
  );
}
