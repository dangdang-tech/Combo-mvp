// 50 · 拒绝态单一真源 view 自检（B-30/发布-31，Codex#r3 P1）。忠实假 PG，无真 PG。
//   重点（契约）：
//     · derivePublicationDisplayState 是「发布页/工作台/主页」三处共用的唯一派生（3E 读路径用之、3F 复用同一函数）。
//     · 从 publications.review_status/reject_reason（+ 被拒版定位）派生对外可读发布态，不裸露内部 review_status 码。
//     · readPublicationView（GET /publications/:id、评审裁决回读用）经它落 displayState，证明单一真源在数据/读模型层闭环。
//   反向破坏：直接喂底层状态码组合，断言派生唯一且与读模型一致（杜绝各自从底层码自行拼装的漂移）。
import { describe, it, expect } from 'vitest';
import {
  derivePublicationDisplayState,
  readPublicationView,
} from '../modules/publish/publication-repo.js';
import { PublicationDisplayStateSchema } from '@cb/shared';
import { PublishFakeDb, seedUser, seedCapabilityVersion, type PubRow } from './publish-fakes.js';

describe('derivePublicationDisplayState（拒绝态单一真源派生，r3 P1）', () => {
  it('alpha_pending → pending_review 徽章（非 rejected、不可重发）', () => {
    const s = derivePublicationDisplayState({ reviewStatus: 'alpha_pending' });
    expect(s.badge).toBe('pending_review');
    expect(s.rejected).toBe(false);
    expect(s.rejectReason).toBeNull();
    expect(s.retryEditable).toBe(false);
    expect(PublicationDisplayStateSchema.safeParse(s).success).toBe(true);
  });

  it('published 且无 reject_reason → published 徽章（正常上架）', () => {
    const s = derivePublicationDisplayState({ reviewStatus: 'published', rejectReason: null });
    expect(s.badge).toBe('published');
    expect(s.rejected).toBe(false);
  });

  it('review_rejected（首发被拒下架）→ rejected 可见态 + 原因 + 可重发（有被拒版定位）', () => {
    const s = derivePublicationDisplayState({
      reviewStatus: 'review_rejected',
      rejectReason: '描述与能力不符',
      rejectedVersionId: 'ver-x',
    });
    expect(s.badge).toBe('rejected');
    expect(s.rejected).toBe(true);
    expect(s.rejectReason).toBe('描述与能力不符');
    expect(s.retryEditable).toBe(true);
  });

  it('published 但带 reject_reason 镜像（拒绝回退到上一版）→ 仍 rejected 可见态（创作者侧看到上次被拒提示）', () => {
    const s = derivePublicationDisplayState({
      reviewStatus: 'published',
      rejectReason: '上次那版被拒了',
      rejectedVersionId: 'ver-prev-rejected',
    });
    expect(s.badge).toBe('rejected');
    expect(s.rejected).toBe(true);
    expect(s.rejectReason).toBe('上次那版被拒了');
    expect(s.retryEditable).toBe(true);
  });

  it('rejected 但无被拒版定位（理论边界）→ 不可重发（retryEditable=false，无处可基于编辑）', () => {
    const s = derivePublicationDisplayState({
      reviewStatus: 'review_rejected',
      rejectReason: 'x',
      rejectedVersionId: null,
    });
    expect(s.rejected).toBe(true);
    expect(s.retryEditable).toBe(false);
  });
});

describe('readPublicationView 经单一真源派生落 displayState（3E 读路径证明，r3 P1）', () => {
  function seedPub(db: PublishFakeDb, over: Partial<PubRow>): string {
    const owner = seedUser(db);
    const cur = seedCapabilityVersion(db, owner, { status: 'published', isCurrent: true });
    db.publications.set(cur.capabilityId, {
      capability_id: cur.capabilityId,
      current_version_id: cur.versionId,
      share_token: `tok-${cur.capabilityId}`,
      visibility: 'public',
      review_status: 'published',
      reject_reason: null,
      published_at: '2026-06-15T00:00:00.000Z',
      ...over,
    });
    return cur.capabilityId;
  }

  it('published 无原因 → view.displayState.badge=published（与派生一致）', async () => {
    const db = new PublishFakeDb();
    const capabilityId = seedPub(db, { review_status: 'published', reject_reason: null });
    const view = await readPublicationView(db, capabilityId);
    expect(view!.displayState).toEqual(
      derivePublicationDisplayState({ reviewStatus: 'published', rejectReason: null }),
    );
    expect(view!.displayState!.badge).toBe('published');
  });

  it('回退后 published+reject_reason 镜像 → displayState.rejected=true（发布页拒绝提示，单源）', async () => {
    const db = new PublishFakeDb();
    const owner = seedUser(db);
    const cur = seedCapabilityVersion(db, owner, { status: 'published', isCurrent: true });
    // 同能力体一条 review_rejected 版（被拒版定位，供「基于被拒版编辑重发」）。
    const rejVid = `ver-rej-${cur.capabilityId}`;
    db.versions.set(rejVid, {
      id: rejVid,
      capability_id: cur.capabilityId,
      version: '0.2.0',
      status: 'review_rejected',
      manifest: db.versions.get(cur.versionId)!.manifest,
      manifest_hash: 'h',
      rejected_at: '2026-06-16T00:00:00.000Z',
      reject_reason: '描述与能力不符',
    });
    db.publications.set(cur.capabilityId, {
      capability_id: cur.capabilityId,
      current_version_id: cur.versionId,
      share_token: 'tok',
      visibility: 'public',
      review_status: 'published', // 对外是回退后的旧版（正常上架）
      reject_reason: '描述与能力不符', // 创作者侧镜像（上次那版被拒了）
      published_at: '2026-06-15T00:00:00.000Z',
    });
    const view = await readPublicationView(db, cur.capabilityId);
    expect(view!.displayState!.rejected).toBe(true);
    expect(view!.displayState!.rejectReason).toBe('描述与能力不符');
    expect(view!.displayState!.retryEditable).toBe(true);
    expect(view!.rejectedVersionId).toBe(rejVid); // 被拒版定位
  });
});
