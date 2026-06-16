// 60 · 作品墙单源过滤/回退（B-33 ⑥，60-dashboard-profile §2.6，决策④，主页-11/19/23/24，B-30）。纯逻辑、便于单测。
//   单一真源（3E）：作品墙读 publications（与发布页/工作台同源），按 review_status 过滤——
//     - review_status ∈ {alpha_pending, published} → 上墙（alpha_pending 按公开口径展示，不暴露内部审核状态码，主页-19）。
//     - review_status = 'review_rejected' → 不上墙（被拒下架不残留、不暴露 review_rejected，主页-23）。
//   回退展示上一 published 版（主页-24）：回退在【评审域】已落库——publications.current_version_id 已指回退后的上一
//     published 版、review_status 已回到 'published'（见 50 评审 reject 回退路径）。故作品墙只需读 current_version_id
//     对应版本的 name/cover 即可，天然展示回退版；不在本域重做回退逻辑（don't reinvent，复用 3E 单源）。
//   usage 占位（主页-11/19/24）：invocations 恒 null + meta.placeholders（coverUrl/name 真实）。
import type { WorkCard } from '@cb/shared';

/** 上墙资格的 review_status（公开口径，主页-19/23）。 */
export const WALL_VISIBLE_REVIEW_STATUS: ReadonlySet<string> = new Set([
  'alpha_pending',
  'published',
]);

/** 作品墙读模型行（publications JOIN capabilities/版本，读 current_version_id 对应展示版）。 */
export interface WorkRow {
  capabilityId: string;
  /** 展示版本（被拒回退则已是回退后的上一 published 版，主页-24）。 */
  versionId: string;
  slug: string;
  reviewStatus: string;
  /** manifest 软字段 name（公开口径，真实）。 */
  name: string;
  /** 封面展示 url（缺图 → null，前端兜底占位，主页-22）。 */
  coverUrl: string | null;
}

/** 是否上墙（被拒下架不上墙；alpha_pending/published 上墙）。 */
export function isOnWall(reviewStatus: string): boolean {
  return WALL_VISIBLE_REVIEW_STATUS.has(reviewStatus);
}

/**
 * 行 → 公开口径 WorkCard（主页-11/19）。invocations 恒 null（usage 占位）；
 *   绝不带 review_status 原始码 / 钱 / 成本（公开口径，主页-19/23/24）。
 */
export function rowToWorkCard(row: WorkRow): WorkCard {
  return {
    capabilityId: row.capabilityId,
    versionId: row.versionId,
    slug: row.slug,
    coverUrl: row.coverUrl,
    name: row.name,
    invocations: null, // usage 占位（meta.placeholders）。
  };
}

/**
 * 过滤 + 投影作品墙卡（决策④/B-30）。入参是已按时间倒序的候选行（含 review_rejected）。
 *   - 仅保留 isOnWall 的行（被拒下架剔除，主页-23）。
 *   - 回退版已在评审域落库为 current_version_id（review_status='published'），故保留即展示回退版（主页-24）。
 *   返回投影后的公开卡（顺序保持入参顺序）。
 */
export function filterWorkCards(rows: WorkRow[]): WorkCard[] {
  return rows.filter((r) => isOnWall(r.reviewStatus)).map(rowToWorkCard);
}
