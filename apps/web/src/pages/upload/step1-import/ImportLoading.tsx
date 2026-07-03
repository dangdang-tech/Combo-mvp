// STEP① 导入加载态（F-10，开工总纲 §5.1）——三层「永不裸转圈」。
//
// 三层（导入-07/08/09/10）：
//   1. 总进度条 + 量化文案（「68% · 已抓取 146 / 215 段会话」）——复用 4A ProgressBar（StreamLoading 承载）。
//   2. 子任务清单依次点亮（连接凭证 / 拉取会话索引 / 导入去敏 / 切段 / 生成原始数据）——复用 4A SubtaskChecklist。
//   3. 导入清单卡：每抓一段先显示一段（item-appended ImportedSegmentBrief），逐行会话状态（导入中…/已入）。
// 另：后台执行说明 + 取消链接（导入-12/06，可关页云端续跑）；reconnecting/slow_hint 由 StreamLoading 承载，
//   error 态不在本件渲染（上层据 state.status==='error' 切 ErrorState）。
import type { ReactElement } from 'react';
import type { ImportedSegmentBrief } from '@cb/shared';
import type { UseSSEState } from '../../../api/index.js';
import { StreamLoading, ItemStream } from '../../../components/index.js';

export interface ImportLoadingProps {
  /** useSSE(jobEventsUrl, 'job') 返回的连接级状态。 */
  state: UseSSEState;
  /** 取消导入（导入-12，可关页云端续跑）。不传则不渲染取消链接。 */
  onCancel?: () => void;
  /** 取消请求在途（链接禁用 + 显「取消中…」）。 */
  cancelling?: boolean;
  /** 整体失败/超时重试（透传 StreamLoading→ErrorState 的 retry）。 */
  onRetry?: () => void;
}

/** 单条落库卡（逐行会话状态：导入中… / 已入，导入-09）。 */
function SegmentRow({ seg }: { seg: ImportedSegmentBrief }): ReactElement {
  const imported = seg.status === 'imported';
  return (
    <div className="cb-import-seg" data-status={seg.status}>
      <span className="cb-import-seg__date">{seg.dateLabel}</span>
      <span className="cb-import-seg__title">{seg.title}</span>
      <span className="cb-import-seg__count">{seg.messageCount} 条</span>
      <span className="cb-import-seg__state">{imported ? '已入' : '导入中…'}</span>
    </div>
  );
}

export function ImportLoading({
  state,
  onCancel,
  cancelling = false,
  onRetry,
}: ImportLoadingProps): ReactElement {
  // 已抓取的落库卡（item-appended 累积；state.items 是 unknown[]，按导入域 DTO 收窄渲染）。
  const segments = state.items as ImportedSegmentBrief[];
  // 仍在跑（非 done/error）时尾部补骨架，暗示「后面还有，正在来」。
  const flowing = state.status !== 'done' && state.status !== 'error';

  return (
    <section className="cb-import-loading" aria-label="正在导入你的对话历史">
      {/* 第 1+2 层：进度条 + 量化文案 + 子任务清单（含 reconnecting/slow_hint 安抚，永不裸转圈）。 */}
      <StreamLoading
        state={state}
        skeletonRows={5}
        label="正在导入"
        {...(onRetry ? { onRetry } : {})}
      />

      {/* error 态由 StreamLoading 内部切 ErrorState；此时不再渲染清单/取消（避免重复噪声）。 */}
      {state.status !== 'error' && (
        <>
          {/* 第 3 层：导入清单卡（每抓一段先显示一段，逐行会话状态）。 */}
          <div className="cb-import-loading__list" aria-label="已抓取的会话">
            <ItemStream<ImportedSegmentBrief>
              items={segments}
              renderItem={(seg) => <SegmentRow seg={seg} />}
              itemKey={(seg) => seg.segmentId}
              pendingSkeletons={flowing ? 2 : 0}
              emptyLabel="正在抓取第一段会话…"
            />
          </div>

          {/* 后台执行说明 + 取消链接（导入-06/12）。 */}
          {flowing && (
            <footer className="cb-import-loading__foot">
              <p className="cb-import-loading__bg-note">
                可以关掉这一页，云端会继续处理，完成后再回来即可。
              </p>
              {onCancel && (
                <button
                  type="button"
                  className="cb-link cb-import-loading__cancel"
                  onClick={onCancel}
                  disabled={cancelling}
                >
                  {cancelling ? '取消中…' : '取消导入'}
                </button>
              )}
            </footer>
          )}
        </>
      )}
    </section>
  );
}
