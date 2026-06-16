// 50 · 发布态读模型 + 拒绝态单一真源派生（B-30，50-step5-publish §2.6.2，Codex#r3 P1）。
//   创作者侧只读 PublicationView：当前对外版/审核态/拒绝原因镜像/被拒版定位/私享 token/可见性/时刻 + displayState
//   （对外拒绝态派生）。注入 Queryable，无真 PG，便于 mock。
//   【拒绝态单一真源】（发布-31，B-30）：发布页/工作台/主页都读 publications.review_status/reject_reason（人话镜像），
//     权威被拒原因在被拒版本行（capability_versions.reject_reason/rejected_at，§1.3）；此读模型把两者拼成 PublicationView，
//     再经 derivePublicationDisplayState 唯一派生对外可读发布态（badge/statusLabel/rejected/retryEditable）。
//     · 3E（本轮）：发布读端点（GET /publications/:id、评审裁决回读）经本读模型证明单一真源。
//     · 3F（下一子阶段）：工作台能力表 / 主页作品墙读路径【复用 derivePublicationDisplayState】，三处经同一真源 + 同一派生，
//       不各自从底层状态码自行拼装（杜绝漂移、禁裸露内部码）。本轮不实现 dashboard/profile 完整页（诚实推迟，见交付说明）。
//   被拒版定位（Codex#8）：rejectedVersionId 取本能力体最近一条 review_rejected 版（供创作者「基于被拒版编辑重发」，
//     前端按它走 40 端点 A POST /capabilities?fromVersionId=<被拒版> 派生新 draft，闭环）。
import type { PublicationView, PublicationDisplayState } from '@cb/shared';
import type { Queryable } from '../jobs/types.js';

export interface PublicationViewRow extends PublicationView {
  /** owner 守门用（handler 据此 403；不进对外 PublicationView）。 */
  ownerUserId: string;
}

/** 状态徽章人话文案（三处同源；对外不裸露 review_status 码，发布-31 / D1）。 */
const STATUS_LABEL: Record<PublicationDisplayState['badge'], string> = {
  pending_review: 'Alpha 待审核',
  published: '已发布',
  rejected: '未通过',
};

/**
 * 【拒绝态单一真源】派生（B-30/发布-31，Codex#r3 P1）。从 publications.review_status/reject_reason（+ 被拒版定位）
 *   派生对外可读发布态——这是「发布页 / 工作台能力表 / 主页作品墙」三处共用的唯一派生入口。纯函数、无 IO。
 *   3E 自己的发布读端点（readPublicationView → GET /publications/:id、评审裁决回读）经它读；
 *   3F 工作台/主页读路径【复用本函数】（don't reinvent）：三处经同一 publications 真源 + 同一派生，状态一致不漂移。
 *   语义（§1.3）：
 *     - review_status='review_rejected'（首发被拒下架）→ rejected 可见态、出原因 + 可基于被拒版编辑重发。
 *     - review_status='published' 但带 reject_reason 镜像（拒绝回退到上一版：对外是正常上架旧版、但创作者侧仍看到
 *       「上次那版被拒了」的提示 + 可编辑重发被拒版）→ rejected 可见态（badge 仍 rejected，对外展示由 listing 投影按
 *       回退版 visibility 决定，此处只管创作者侧拒绝提示真源）。
 *     - review_status='alpha_pending' → pending_review。
 *     - 其余 published 且无 reject_reason → published。
 */
export function derivePublicationDisplayState(input: {
  reviewStatus: string;
  rejectReason?: string | null;
  rejectedVersionId?: string | null;
}): PublicationDisplayState {
  const reason = input.rejectReason ?? null;
  // 被拒可见态：review_rejected（下架）或 published 但带被拒原因镜像（回退后创作者侧仍提示上次被拒）。
  const rejected =
    input.reviewStatus === 'review_rejected' ||
    (input.reviewStatus === 'published' && reason !== null && reason.length > 0);

  const badge: PublicationDisplayState['badge'] = rejected
    ? 'rejected'
    : input.reviewStatus === 'alpha_pending'
      ? 'pending_review'
      : 'published';

  return {
    badge,
    statusLabel: STATUS_LABEL[badge],
    rejected,
    rejectReason: rejected ? reason : null,
    // 可重发：有被拒版可定位即可基于它编辑重发（rejectedVersionId 存在）。
    retryEditable: rejected && !!input.rejectedVersionId,
  };
}

/**
 * 读创作者侧 PublicationView（§2.6.2）。JOIN capabilities 取 slug/owner；
 *   rejectReason 取 publications 镜像（人话，发布-31）；rejectedVersionId/rejectedAt 取本能力体最近一条
 *   review_rejected 版（被拒版本线权威，§1.3，供「编辑重发」定位）。不存在 publication → null（404）。
 */
export async function readPublicationView(
  db: Queryable,
  capabilityId: string,
): Promise<PublicationViewRow | null> {
  const res = await db.query<{
    capability_id: string;
    current_version_id: string;
    slug: string;
    share_token: string;
    visibility: string;
    review_status: string;
    reject_reason: string | null;
    reviewed_at: string | null;
    published_at: string;
    owner_user_id: string;
    rejected_version_id: string | null;
    rejected_at: string | null;
  }>(
    `SELECT p.capability_id,
            p.current_version_id,
            c.slug,
            p.share_token,
            p.visibility,
            p.review_status,
            p.reject_reason,
            p.reviewed_at,
            p.published_at,
            c.creator_user_id AS owner_user_id,
            rej.id            AS rejected_version_id,
            rej.rejected_at   AS rejected_at
       FROM publications p
       JOIN capabilities c ON c.id = p.capability_id
       LEFT JOIN LATERAL (
         SELECT r.id, r.rejected_at
           FROM capability_versions r
          WHERE r.capability_id = p.capability_id
            AND r.status = 'review_rejected'
          ORDER BY r.rejected_at DESC NULLS LAST
          LIMIT 1
       ) rej ON true
      WHERE p.capability_id = $1`,
    [capabilityId],
  );
  const r = res.rows[0];
  if (!r) return null;

  const view: PublicationViewRow = {
    capabilityId: r.capability_id,
    currentVersionId: r.current_version_id,
    slug: r.slug,
    shareToken: r.share_token,
    visibility: r.visibility as PublicationView['visibility'],
    reviewStatus: r.review_status as PublicationView['reviewStatus'],
    publishedAt: r.published_at,
    ownerUserId: r.owner_user_id,
  };
  if (r.reject_reason !== null) view.rejectReason = r.reject_reason;
  if (r.rejected_version_id !== null) view.rejectedVersionId = r.rejected_version_id;
  if (r.rejected_at !== null) view.rejectedAt = r.rejected_at;
  if (r.reviewed_at !== null) view.reviewedAt = r.reviewed_at;
  // 拒绝态单一真源派生（3E 读路径据此出对外态；3F 工作台/主页复用 derivePublicationDisplayState，Codex#r3 P1）。
  view.displayState = derivePublicationDisplayState({
    reviewStatus: r.review_status,
    rejectReason: r.reject_reason,
    rejectedVersionId: r.rejected_version_id,
  });
  return view;
}
