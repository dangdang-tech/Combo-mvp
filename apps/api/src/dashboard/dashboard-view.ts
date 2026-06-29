// 60 · 工作台读模型投影（B-32，60-dashboard-profile §1.1/§1.2/§1.3/§1.4）。纯函数：行 → 对外读模型。
//   职责：把 capabilities/capability_versions/publications 行投影成 DashboardSummary / DashboardMetrics /
//         TokenTrend / DashboardCapabilityRow（usage 字段统一占位 null，真实字段照投）。
//   状态列【单一真源】：能力表 reviewStatus/statusLabel/rejectReason/retryEditable 由 3E 单源派生
//     derivePublicationDisplayState（publications.review_status/reject_reason）+ 工作台展示态补充
//     （draft/unpublished 两个【派生】态）落定，绝不各自从底层 review_status 码自行拼装（杜绝漂移，§1.4 注）。
import type {
  DashboardSummary,
  DashboardMetrics,
  MetricCard,
  TokenTrend,
  DashboardCapabilityRow,
  CapabilityReviewStatus,
  Range,
} from '@cb/shared';
import { derivePublicationDisplayState } from '../publish/publication-repo.js';

/** 页头固定标题（外壳首页-08）。 */
export const DASHBOARD_TITLE = '创作者中心';

/** 摘要句模板（含占位符，前端代入 publishedCount + 占位文案，§1.1）。 */
export const SUMMARY_TEMPLATE = '你发布的 {publishedCount} 个能力体，{monthlyInvocations} 次调用';

/**
 * 页头经营摘要（§1.1）。publishedCount 真实；monthlyInvocations usage 占位 null（meta.placeholders 标注）。
 *   summaryTemplate 含占位符，前端用真实 publishedCount + 得体占位文案拼装（非裸 0）。
 */
export function buildSummary(publishedCount: number): DashboardSummary {
  return {
    title: DASHBOARD_TITLE,
    publishedCount,
    monthlyInvocations: null, // usage 占位（§1.1）
    summaryTemplate: SUMMARY_TEMPLATE,
  };
}

/** 能力表本月调用环比方向（usage 卡占位时为 null；published 卡按真实差值算）。 */
function deltaDirectionOf(current: number, previous: number): 'up' | 'down' | 'flat' {
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

/** 真实环比百分比（published 卡用；previous=0 时涨幅无意义 → null，前端不画环比）。 */
function deltaPercentOf(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10; // 一位小数
}

/**
 * 四张大数字卡 + 环比（§1.2，外壳首页-09/29）。顺序固定四张缺一不可：
 *   published（真实值 + 真实环比）、invocationsTotal/spendThisMonth/activeConsumers（usage 占位三 null）。
 *
 * 环比口径修正（Codex#r3 P1）：value 是【总】已发布数（外壳首页-09 大数字）；但环比 delta/方向必须用
 *   【同口径】两窗对比——当前窗口【新增】published 数 vs 上一窗口【新增】published 数。
 *   绝不用「总数（current）vs 上一窗口新增（previous）」混口径：那会让「旧能力很多、当前窗口新增 0、
 *   上一窗口新增>0」误报为 up（总数恒 >= 上一窗口新增），方向错（外壳首页-29 要求涨跌方向正确）。
 *
 * @param totalPublishedCount   总已发布能力体数（真实，卡 value）。
 * @param currentWindowPublished  当前区间【新增】published 数（环比 current 侧；range='all' → null）。
 * @param prevWindowPublished     上一区间【新增】published 数（环比 previous 侧；range='all' → null）。
 */
export function buildMetrics(
  range: Range,
  totalPublishedCount: number,
  currentWindowPublished: number | null,
  prevWindowPublished: number | null,
): DashboardMetrics {
  // published 卡：value=总数；环比用两窗【新增】同口径对比（任一侧 null，如 all 档 → 环比置 null，不裸造）。
  const hasWindow = currentWindowPublished !== null && prevWindowPublished !== null;
  const publishedCard: MetricCard = {
    key: 'published',
    label: '已发布能力体',
    value: totalPublishedCount,
    deltaPercent: hasWindow ? deltaPercentOf(currentWindowPublished, prevWindowPublished) : null,
    deltaDirection: hasWindow
      ? deltaDirectionOf(currentWindowPublished, prevWindowPublished)
      : null,
    unit: '能力体',
  };
  // usage 三卡：value/deltaPercent/deltaDirection 三者均 null（占位，meta.placeholders 标注三键，§1.2）。
  const usageCard = (
    key: 'invocationsTotal' | 'spendThisMonth' | 'activeConsumers',
    label: string,
    unit: string,
  ): MetricCard => ({
    key,
    label,
    value: null,
    deltaPercent: null,
    deltaDirection: null,
    unit,
  });
  return {
    range,
    cards: [
      publishedCard,
      usageCard('invocationsTotal', '累计调用', '次'),
      usageCard('spendThisMonth', '本月消耗', 'tokens'),
      usageCard('activeConsumers', '活跃消费者', '人'),
    ],
  };
}

/**
 * 每日 token 消耗趋势（§1.3，外壳首页-10/26）。本期整图占位：points 空数组、peak null、empty true。
 *   切换 metric/range 照常回（不报错）；区间无消耗 = empty:true，前端给「暂无消耗」空态、不误标峰值、不破图。
 */
export function buildTokenTrend(range: Range, metric: 'tokens' | 'invocations'): TokenTrend {
  return {
    range,
    metric,
    points: [], // 本期无数据（非转圈、非报错）
    peak: null, // 不误标峰值（§1.3）
    empty: true,
  };
}

/** capability + version + publication 联表行（dashboard-repo 读出，view 投影所需列）。 */
export interface DashboardCapabilityJoinRow {
  capability_id: string;
  version_id: string; // 当前展示版本（被拒回退则 capabilities.current_version_id）
  slug: string;
  name: string; // manifest 软字段（真实）
  tagline: string; // manifest 软字段（真实）
  /** publications.review_status（存储 3 值之一；无 publication 行则 null = 未发布草稿）。 */
  review_status: string | null;
  /** publications.reject_reason 人话镜像（仅被拒态有）。 */
  reject_reason: string | null;
  /** 最近一条 review_rejected 版定位（供「基于被拒版编辑重发」，retryEditable 判定）。 */
  rejected_version_id: string | null;
  /** 该能力是否有任意 published 版（用于派生 unpublished：被拒下架=无上一 published 版）。 */
  has_published_version: boolean;
  published_at: string | null;
  updated_at: string;
}

/** 派生展示状态枚举 → 人话状态文案（§1.4，对外不裸露 review_status 码）。 */
const STATUS_LABEL: Record<CapabilityReviewStatus, string> = {
  alpha_pending: 'Alpha·审核中',
  published: '已上架',
  review_rejected: '已退回',
  draft: '草稿',
  unpublished: '已下架',
};

/**
 * 能力表【状态列单一真源派生】（§1.4，关键合规点）。
 *   先经 3E 单源 derivePublicationDisplayState（publications.review_status/reject_reason）出对外发布态，
 *   再在其上叠工作台两个【展示派生】态：
 *     - draft        ← 无 publication 行（review_status=null，= 未发布）
 *     - unpublished  ← review_rejected 且无上一 published 版（被拒下架）
 *   绝不把 draft/unpublished 写回 publications.review_status；这是「三处经同一真源 + 同一派生不漂移」的工作台落点。
 */
export function deriveCapabilityReviewStatus(
  row: DashboardCapabilityJoinRow,
): CapabilityReviewStatus {
  // 无 publication 行 = 未发布草稿（capability_versions.status=draft，§1.4 派生态）。
  if (row.review_status === null) return 'draft';

  const display = derivePublicationDisplayState({
    reviewStatus: row.review_status,
    rejectReason: row.reject_reason,
    rejectedVersionId: row.rejected_version_id,
  });

  // 被拒可见态：区分「下架（无上一 published 版）」与「回退（有上一 published 版，对外仍上架旧版）」。
  if (display.rejected) {
    if (row.review_status === 'review_rejected' && !row.has_published_version) {
      return 'unpublished'; // 被拒下架（§1.4 / 主页-23 同口径）
    }
    return 'review_rejected'; // 被拒但有上一版回退/或被拒态可见（statusLabel「已退回」）
  }

  // 非拒绝：alpha_pending → alpha_pending；其余 published → published（与单源派生 badge 同口径）。
  return display.badge === 'pending_review' ? 'alpha_pending' : 'published';
}

/**
 * 能力表行投影（§1.4，外壳首页-11/14/15/30-B30）。
 *   - 状态列：deriveCapabilityReviewStatus（单一真源派生，绝不自行拼装）。
 *   - usage 列：monthlyInvocations/spendSparkline/revenueMicros 本期 null（meta.placeholders 逐键标注）。
 *   - 试用：actions.trial 恒 {enabled:false, hint:'本期未开放'}（决策③，按钮在、点击落占位）。
 *   - 拒绝态：reviewStatus 含 review_rejected → rejectReason 人话原因 + retryEditable=true（有被拒版定位才可重发）。
 */
export function toDashboardCapabilityRow(row: DashboardCapabilityJoinRow): DashboardCapabilityRow {
  const reviewStatus = deriveCapabilityReviewStatus(row);
  const isRejected = reviewStatus === 'review_rejected';
  return {
    capabilityId: row.capability_id,
    versionId: row.version_id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    reviewStatus,
    statusLabel: STATUS_LABEL[reviewStatus],
    // 拒绝原因仅在退回态出（人话镜像，B-30 三处可见之一）；其它态 null。
    rejectReason: isRejected ? (row.reject_reason ?? null) : null,
    // 可重试编辑：被退回且有被拒版可定位（与 3E 单源 retryEditable 同口径）。
    retryEditable: isRejected && row.rejected_version_id !== null,
    monthlyInvocations: null, // usage 占位
    spendSparkline: null, // usage 占位（消耗迷你图）
    revenueMicros: null, // usage 占位（收益）
    actions: {
      trial: { enabled: false, hint: '本期未开放' }, // 决策③，按钮在但本期未开放
      edit: true, // 进草稿/编辑（外壳首页-15）
      more: true, // 更多菜单：下架/改价/查看（外壳首页-35）
    },
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}
