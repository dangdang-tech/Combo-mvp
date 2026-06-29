// 分区局部错误条（主页-17）——某分区数据源失败时，只在该分区位置出一条局部错误 + 重试，
// 其它分区正常展示、整页不崩。复用 4A ErrorState（只 userMessage + action，绝不裸露 code）。
//
// 这里构造一个「分区失败」的对外 ErrorBody（人话取契约 §2.7 PROFILE_SECTION_FAILED 的 userMessage，
// action=retry），交给 ErrorState 渲染——绝不前端编错误码、绝不整页换错误页。
import type { ReactElement } from 'react';
import type { ErrorBody } from '@cb/shared';
import { ErrorState } from '../../components/index.js';

export interface SectionErrorProps {
  /** 分区中文名（用于无障碍标题，如「会话足迹」）。 */
  sectionLabel: string;
  /** 是否正在重试（重试中禁用按钮、文案改「重试中…」）。 */
  retrying?: boolean;
  /** 子端点重试回调。 */
  onRetry: () => void;
}

/** 契约 §2.7：单分区失败的人话（PROFILE_SECTION_FAILED）。对外信封无 code，这里只给 userMessage。 */
const SECTION_FAILED_BODY: ErrorBody = {
  userMessage: '这个分区没能加载，请重试。',
  retriable: true,
  action: 'retry',
  traceId: '',
};

export function SectionError({
  sectionLabel,
  retrying = false,
  onRetry,
}: SectionErrorProps): ReactElement {
  return (
    <div
      className="cb-profile-section__error"
      data-section-error
      aria-label={`${sectionLabel}加载失败`}
    >
      {retrying ? (
        <p className="cb-profile-section__retrying" role="status">
          {sectionLabel}重试中…
        </p>
      ) : (
        <ErrorState error={SECTION_FAILED_BODY} onRetry={onRetry} />
      )}
    </div>
  );
}
