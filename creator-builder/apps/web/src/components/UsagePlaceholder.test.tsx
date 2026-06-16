// UsagePlaceholder 测试（脊柱 §2.2 占位）：placeholders 标注时显示「暂无数据/上线后填充」，
// 绝不显 0、绝不裸转圈。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Meta } from '@cb/shared';
import {
  UsagePlaceholder,
  isPlaceholder,
  placeholderText,
  USAGE_PLACEHOLDER_FALLBACK,
} from './UsagePlaceholder.js';

const metaWithPlaceholder: Meta = {
  placeholders: { monthlyInvocations: '暂无数据 / 上线后填充' },
};

describe('UsagePlaceholder', () => {
  it('显示后端给的占位文案', () => {
    render(
      <UsagePlaceholder field="monthlyInvocations" meta={metaWithPlaceholder} label="本月调用" />,
    );
    expect(screen.getByText('暂无数据 / 上线后填充')).toBeInTheDocument();
    expect(screen.getByText('本月调用')).toBeInTheDocument();
  });

  it('占位文案绝不是 0', () => {
    render(<UsagePlaceholder field="monthlyInvocations" meta={metaWithPlaceholder} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('meta 缺占位键 → 兜底默认句（仍不裸转圈/不显 0）', () => {
    render(<UsagePlaceholder field="revenueMicros" meta={{}} />);
    expect(screen.getByText(USAGE_PLACEHOLDER_FALLBACK)).toBeInTheDocument();
  });

  it('data-placeholder 标记字段键（样式/定位用）', () => {
    const { container } = render(
      <UsagePlaceholder field="tokenTrend" meta={metaWithPlaceholder} />,
    );
    expect(container.querySelector('[data-placeholder="tokenTrend"]')).toBeInTheDocument();
  });
});

describe('isPlaceholder / placeholderText 辅助', () => {
  it('isPlaceholder：标注了该字段 → true', () => {
    expect(isPlaceholder(metaWithPlaceholder, 'monthlyInvocations')).toBe(true);
    expect(isPlaceholder(metaWithPlaceholder, 'publishedCount')).toBe(false);
    expect(isPlaceholder(undefined, 'x')).toBe(false);
  });

  it('placeholderText：后端优先，缺省兜底', () => {
    expect(placeholderText(metaWithPlaceholder, 'monthlyInvocations')).toBe(
      '暂无数据 / 上线后填充',
    );
    expect(placeholderText({}, 'x')).toBe(USAGE_PLACEHOLDER_FALLBACK);
  });
});
