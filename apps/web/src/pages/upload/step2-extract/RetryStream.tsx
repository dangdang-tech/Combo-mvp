// 单候选重试回填流（F-11，开工总纲 §5.2 / 30 §2.3）——连 retryJob 新流，把回填 item 上抛父级。
//
// 为什么独立组件（Codex#4）：单候选重试**不在原萃取 job 流上追加**（原 job 已 terminal、流已关），
//   而是新建 retryJob、走其全新 eventsUrl 推回填。前端对每个在途重试挂一个本组件（key=retryJobId）订阅该流；
//   收到 item-appended（同 candidateId）即上抛父级原地替换失败行；retryJob done 后上抛完成（父卸载本组件）。
// 回填靠 item.id == candidateId 对位（跨流，与原萃取 job 无关）。本组件不渲染 UI（纯订阅副作用）。
import { useEffect, type ReactElement } from 'react';
import type { CandidateItem } from '@cb/shared';
import { useSSE } from '../../../api/index.js';
import { jobEventsUrl } from './extractApi.js';

export interface RetryStreamProps {
  /** 重试候选 id（回填对位用）。 */
  candidateId: string;
  /** retryJob id（新流，30 §2.3）。 */
  retryJobId: string;
  /** 收到回填 item（status 变 ready/failed）时上抛父级原地替换。 */
  onItem: (item: CandidateItem) => void;
  /** retryJob 终止（done/error）时上抛父级（清在途态、卸载本组件）。 */
  onFinished: (candidateId: string) => void;
}

export function RetryStream({
  candidateId,
  retryJobId,
  onItem,
  onFinished,
}: RetryStreamProps): ReactElement | null {
  const sse = useSSE(jobEventsUrl(retryJobId), 'job');

  // 回填：retryJob 流上 item-appended 累积进 state.items（useSSE 已取 payload.item）；
  // 取与本候选对位的最新一帧上抛（同 candidateId）。
  const items = sse.items as CandidateItem[];
  const latest = items.filter((i) => i.id === candidateId).at(-1);
  useEffect(() => {
    if (latest) onItem(latest);
  }, [latest, onItem]);

  // retryJob 终止 → 上抛清在途（done 正常完成 / error 整体失败都算终止本次重试）。
  useEffect(() => {
    if (sse.status === 'done' || sse.status === 'error') onFinished(candidateId);
  }, [sse.status, candidateId, onFinished]);

  return null;
}
