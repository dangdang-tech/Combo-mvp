// 60 · 工作台 usage 占位口径（B-32，60-dashboard-profile §决策② / 脊柱 §2.2）。
//   本期所有 usage 类指标统一返回 value=null + meta.placeholders[field]=USAGE_PLACEHOLDER_TEXT，
//   绝不返 0（误导）、不空错误、不裸转圈。文案为契约冻结的唯一占位句（§2.2）。
//   非 usage 维度（已发布数、能力名/简介/状态、草稿条）正常返真实值，不进 placeholders。

/** 占位文案（契约 §2.2 冻结，三处同句；前端可直接渲染「暂无数据 / 上线后填充」灰态）。 */
export const USAGE_PLACEHOLDER_TEXT = '暂无数据 / 上线后填充';

/** 工作台 summary 的 usage 占位键（页头摘要「本月被调用」，外壳首页-08）。 */
export const SUMMARY_USAGE_PLACEHOLDERS = {
  monthlyInvocations: USAGE_PLACEHOLDER_TEXT,
} as const;

/**
 * metrics 四卡里三张 usage 卡的占位键（外壳首页-09/29）。
 *   published 卡是真实值（不进 placeholders）；其余三卡 value/deltaPercent/deltaDirection 三者均 null。
 */
export const METRICS_USAGE_PLACEHOLDERS = {
  invocationsTotal: USAGE_PLACEHOLDER_TEXT,
  spendThisMonth: USAGE_PLACEHOLDER_TEXT,
  activeConsumers: USAGE_PLACEHOLDER_TEXT,
} as const;

/** token-trend 整图占位键（外壳首页-10/26：points 空、peak null、empty true）。 */
export const TOKEN_TREND_USAGE_PLACEHOLDERS = {
  points: USAGE_PLACEHOLDER_TEXT,
} as const;

/** 能力表 usage 列占位键（外壳首页-11：本月调用/消耗迷你图/收益逐列 null）。 */
export const CAPABILITY_ROW_USAGE_PLACEHOLDERS = {
  monthlyInvocations: USAGE_PLACEHOLDER_TEXT,
  spendSparkline: USAGE_PLACEHOLDER_TEXT,
  revenueMicros: USAGE_PLACEHOLDER_TEXT,
} as const;
