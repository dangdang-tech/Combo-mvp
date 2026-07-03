// UsagePlaceholder（脊柱 §2.2 占位语义）——usage 类指标本期统一占位。
//
// 决策②：本月消耗 / 调用次数 / 活跃消费者 / token 趋势 / 收益 / 热度数字等 usage 字段，
// 本期一律返回 `value=null` + `meta.placeholders[field]="暂无数据 / 上线后填充"`：
//   - 绝不显示 0（误导成「真有 0 次调用」）。
//   - 绝不裸转圈/空白。
//   - 显示得体占位文案（优先用后端给的 placeholders[field]，否则兜底默认句）。
// 调用方：拿到 Meta.placeholders + 字段值，值为 null/undefined 时渲染本件，否则渲染真实值。
import type { ReactElement } from 'react';
import type { Meta } from '@cb/shared';

/** 占位兜底文案（与脊柱 §2.2 一致；后端 placeholders[field] 优先）。 */
export const USAGE_PLACEHOLDER_FALLBACK = '暂无数据 / 上线后填充';

export interface UsagePlaceholderProps {
  /** 字段逻辑键（与 meta.placeholders 的键一致，如 'monthlyInvocations'）。 */
  field: string;
  /** 响应 meta（取 meta.placeholders[field] 作占位文案）。 */
  meta?: Meta | undefined;
  /** 可选：占位前缀标签（如「本月消耗」）。 */
  label?: string;
}

/** 判断某字段当前是否处于占位态（值为 null 且 meta.placeholders 标注了它）。 */
export function isPlaceholder(meta: Meta | undefined, field: string): boolean {
  return typeof meta?.placeholders?.[field] === 'string';
}

/** 取某字段的占位文案（后端优先，兜底默认句）。 */
export function placeholderText(meta: Meta | undefined, field: string): string {
  return meta?.placeholders?.[field] ?? USAGE_PLACEHOLDER_FALLBACK;
}

/**
 * usage 占位渲染：显示「暂无数据 / 上线后填充」类得体文案，绝不显 0、绝不裸转圈。
 * data-placeholder 便于样式/测试定位。
 */
export function UsagePlaceholder({ field, meta, label }: UsagePlaceholderProps): ReactElement {
  return (
    <span className="cb-usage-placeholder" data-placeholder={field}>
      {label && <span className="cb-usage-placeholder__label">{label}</span>}
      <span className="cb-usage-placeholder__text">{placeholderText(meta, field)}</span>
    </span>
  );
}
