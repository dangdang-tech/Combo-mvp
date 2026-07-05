// 能力项行：名称/类型/发布状态 + 分享令牌 + 「去试用」「发布/下架」动作。
// 能力页与任务详情页（提取完就地展示）共用。
import { type ReactElement } from 'react';
import type { CapabilityView } from '@cb/shared';
import { trialUrl } from '../../api/index.js';
import { CopyButton } from '../../components/CopyButton.js';

/** 可直接发出去的完整试用链接（对方需登录）。 */
function shareUrl(capabilityId: string): string {
  return `${window.location.origin}${trialUrl(capabilityId)}`;
}

export function CapabilityRow({
  cap,
  pending,
  onToggle,
}: {
  cap: CapabilityView;
  pending: boolean;
  onToggle: (publish: boolean) => void;
}): ReactElement {
  return (
    <li className="cb-caps__item">
      <div className="cb-caps__main">
        <p className="cb-caps__name">
          {cap.name}
          <span className="cb-caps__kind">{cap.kind}</span>
          <span className={`cb-status-badge is-${cap.published ? 'published' : 'unpublished'}`}>
            {cap.published ? '已发布' : '未发布'}
          </span>
        </p>
        <p className="cb-caps__summary">{cap.summary}</p>
        {cap.published && (
          <p className="cb-caps__share">
            {/* 裸 shareToken 无任何路由可消费（断头路）；先给真正能用的试用链接，token 语义等后端落地。 */}
            分享链接：<code className="cb-caps__token">{shareUrl(cap.id)}</code>
            <CopyButton text={shareUrl(cap.id)} />
          </p>
        )}
      </div>
      <div className="cb-caps__actions">
        <a className="cb-caps__trial" href={trialUrl(cap.id)}>
          去试用
        </a>
        <button
          type="button"
          className="cb-caps__toggle"
          data-published={cap.published ? 'true' : 'false'}
          onClick={() => onToggle(!cap.published)}
          disabled={pending}
        >
          {pending ? '处理中…' : cap.published ? '下架' : '发布'}
        </button>
      </div>
    </li>
  );
}
