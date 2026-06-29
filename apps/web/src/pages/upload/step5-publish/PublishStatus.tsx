// 发布态展示（F-14，§5.5 / B-30）——发布后「Alpha·审核中」+ 拒绝态可见（简单原因 + 重试/编辑入口）。
//
// 三态（PublicationView.reviewStatus / displayState）：
//   - alpha_pending：发布成功 →「已提交，Alpha 人工评审中」（发布-15）。
//   - published：已上架（清审核中徽章，发布-21）。
//   - review_rejected：拒绝态可见——简单人话原因（rejectReason）+「编辑重发」（派生新 draft 回结构化）/「重试」。
//
// 拒绝态单一真源（50 §1.3）：rejectReason 是被拒版本线的人话镜像（无 code）；「编辑重发」按 rejectedVersionId 派生。
import type { ReactElement } from 'react';
import type { ReviewStatus } from '@cb/shared';

export interface PublishStatusProps {
  reviewStatus: ReviewStatus;
  /** 人话拒绝原因（review_rejected 时有；无 code，§1.3）。 */
  rejectReason?: string | undefined;
  /** 市集地址（发布成功后「可访问的市集地址」，发布-15）。 */
  marketUrl?: string | undefined;
  /** 「编辑重发」：被拒后派生新 draft 回结构化向导（按 rejectedVersionId，闭环入口）。 */
  onEditResubmit?: () => void;
  /** 「回工作台」：发布成功后退出向导。 */
  onDone?: () => void;
}

const STATUS_TEXT: Record<ReviewStatus, { title: string; hint: string }> = {
  alpha_pending: {
    title: '已提交，Alpha 人工评审中',
    hint: '审核通过后会正式上架；上线后可在工作台看到调用量与消耗。',
  },
  published: {
    title: '已上架',
    hint: '你的能力已在市集可见。',
  },
  review_rejected: {
    title: '这次发布被退回了',
    hint: '看下原因，编辑后可以重新发布。',
  },
};

export function PublishStatus({
  reviewStatus,
  rejectReason,
  marketUrl,
  onEditResubmit,
  onDone,
}: PublishStatusProps): ReactElement {
  const text = STATUS_TEXT[reviewStatus];
  const rejected = reviewStatus === 'review_rejected';

  return (
    <section
      className="cb-publish-status"
      data-status={reviewStatus}
      role="status"
      aria-live="polite"
    >
      <h2 className="cb-publish-status__title">{text.title}</h2>
      <p className="cb-publish-status__hint">{text.hint}</p>

      {/* 拒绝态：简单人话原因可见（非内部码，§1.3）。 */}
      {rejected && rejectReason && (
        <p className="cb-publish-status__reason">退回原因：{rejectReason}</p>
      )}

      <div className="cb-publish-status__actions">
        {rejected ? (
          <button type="button" className="cb-btn cb-btn--primary" onClick={onEditResubmit}>
            编辑后重新发布
          </button>
        ) : (
          <>
            {/* 「查看市集页」仅在能力真正上架（published）后给（BUG-017）：
                alpha_pending 只是「已提交·人工评审中」，能力尚未上线，此时给市集链接会落到「即将上线」占位页、误导用户。
                故评审中不显该入口；待 published 上架、公开消费页接通后再放出可读市集卡。 */}
            {reviewStatus === 'published' && marketUrl && (
              <a className="cb-btn" href={marketUrl} target="_blank" rel="noreferrer">
                查看市集页
              </a>
            )}
            <button type="button" className="cb-btn cb-btn--primary" onClick={onDone}>
              回工作台
            </button>
          </>
        )}
      </div>
    </section>
  );
}
