// 能力表格行：只使用当前 CapabilityView 的真实状态与动作。
// 经营指标尚未接入，显式展示占位，不把设计稿模拟数字带进生产。
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
    <tr className="cb-cap-row" data-capability={cap.id}>
      <td className="cb-cap-row__name">
        <span className="cb-cap-row__title">{cap.name}</span>
        <span className="cb-cap-row__tagline">{cap.summary}</span>
      </td>
      <td className="cb-cap-row__status">
        <span className={`cb-status-badge is-${cap.published ? 'published' : 'unpublished'}`}>
          {cap.published ? '已上架' : '未上架'}
        </span>
      </td>
      <td className="cb-cap-row__metric">
        <span className="cb-cap-row__placeholder">暂无数据 / 上线后填充</span>
      </td>
      <td className="cb-cap-row__metric">
        <span className="cb-cap-row__placeholder">—</span>
      </td>
      <td className="cb-cap-row__metric">
        <span className="cb-cap-row__placeholder">暂无数据 / 上线后填充</span>
      </td>
      <td className="cb-cap-row__actions">
        <a className="cb-cap-action cb-cap-action--trial" href={trialUrl(cap.id)}>
          试用
        </a>
        <button
          type="button"
          className="cb-cap-action cb-cap-action--toggle"
          data-published={cap.published ? 'true' : 'false'}
          onClick={() => onToggle(!cap.published)}
          disabled={pending}
        >
          {pending ? '处理中…' : cap.published ? '下架' : '发布'}
        </button>
        {cap.published && (
          <CopyButton
            text={shareUrl(cap.id)}
            label="复制链接"
            className="cb-cap-action cb-cap-action--copy"
          />
        )}
      </td>
    </tr>
  );
}
