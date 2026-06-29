// 50 发布域单测夹具：内存假 PG，忠实模拟 publish-repo / publish-one 的查询形态 + 发布门单事务
//   （BEGIN/COMMIT/ROLLBACK 真实记账：COMMIT 落盘、ROLLBACK 弃改，验真原子性/防重）。无真 PG / 无 Docker。
//   忠实点（合规清单）：
//     - 守门 UPDATE「status='draft' 才推 published」→ 非 draft 命中 0 行（rowCount=0）。
//     - publications ON CONFLICT (capability_id)：第二次发布命中既有行 → 仍只一条 publication（防重）。
//     - capability_tiers ON CONFLICT (version_id, tier_code) DO NOTHING：已冻结价不被回写。
//     - outbox_events ON CONFLICT (event_id) DO NOTHING：同事件只一行（生产侧幂等）。
//     - 事务内单行单次改、回读 share_token、复合 FK 参数透传。
//   ROLLBACK 语义：每个连接开 BEGIN 时对受影响表打快照，ROLLBACK 还原（验「任一步失败整体回滚、不留半发布态」）。
import type { Queryable, QueryResultLike } from '../jobs/types.js';
import type { Manifest } from '@cb/shared';
import { initialManifest, applySoftFields } from '../structure/manifest.js';

export interface CapRow {
  id: string;
  creator_user_id: string;
  slug: string;
  current_version_id: string | null;
}
export interface VerRow {
  id: string;
  capability_id: string;
  version: string;
  status: string;
  manifest: Manifest;
  manifest_hash: string | null;
  /** 发布时版本级冻结：封面三来源 + 可见性（r3 P1，发布门 ② 同写）。NULL=未冻结（旧版兜 glyph/public）。 */
  cover_source?: string | null;
  cover_asset_key?: string | null;
  cover_snapshot_ref?: string | null;
  visibility?: string | null;
  /** 被拒版本线（评审拒绝落被拒版自身，§1.3）。 */
  reject_reason?: string | null;
  rejected_at?: string | null;
  /** 上一 published 版定位用（superseded 倒序取最近）。 */
  updated_at?: number;
}
export interface UserRow {
  id: string;
  account: string;
}
export interface TierRow {
  version_id: string;
  tier_code: string;
  price_micros: number;
}
export interface PubRow {
  capability_id: string;
  current_version_id: string;
  share_token: string;
  visibility: string;
  review_status: string;
  reject_reason: string | null;
  reviewed_at?: string | null;
  published_at?: string;
}
export interface OutboxRow {
  seq: number;
  event_id: string;
  topic: string;
  aggregate_id: string;
  payload: unknown;
  trace_id: string | null;
}

interface Snapshot {
  capabilities: Map<string, CapRow>;
  versions: Map<string, VerRow>;
  tiers: TierRow[];
  publications: Map<string, PubRow>;
  outbox: OutboxRow[];
}

function ok<R>(rows: R[], rowCount = rows.length): QueryResultLike<R> {
  return { rows, rowCount };
}

let idSeq = 0;
export function genId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${String(idSeq).padStart(6, '0')}`;
}

/**
 * 假 PG（含真事务记账）。query 覆盖 publish-repo 全部 SQL。
 *   connect() 返回一个连接句柄：BEGIN 打快照，COMMIT 清快照（落盘），ROLLBACK 还原快照。
 */
export class PublishFakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  capabilities = new Map<string, CapRow>();
  versions = new Map<string, VerRow>();
  users = new Map<string, UserRow>();
  tiers: TierRow[] = [];
  publications = new Map<string, PubRow>();
  outbox: OutboxRow[] = [];
  outboxSeq = 0;
  /** 注入：发布门第 N 条写后抛错（验回滚；1 = 第一条写后）。 */
  throwAfterWrites: number | null = null;
  private writeCount = 0;
  private snapshot: Snapshot | null = null;

  private takeSnapshot(): void {
    this.snapshot = {
      capabilities: new Map([...this.capabilities].map(([k, v]) => [k, { ...v }])),
      versions: new Map([...this.versions].map(([k, v]) => [k, { ...v }])),
      tiers: this.tiers.map((t) => ({ ...t })),
      publications: new Map([...this.publications].map(([k, v]) => [k, { ...v }])),
      outbox: this.outbox.map((o) => ({ ...o })),
    };
  }
  private restoreSnapshot(): void {
    if (!this.snapshot) return;
    this.capabilities = this.snapshot.capabilities;
    this.versions = this.snapshot.versions;
    this.tiers = this.snapshot.tiers;
    this.publications = this.snapshot.publications;
    this.outbox = this.snapshot.outbox;
    this.snapshot = null;
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });

    if (sql === 'BEGIN') {
      this.takeSnapshot();
      this.writeCount = 0;
      return ok<R>([]);
    }
    if (sql === 'COMMIT') {
      this.snapshot = null;
      return ok<R>([]);
    }
    if (sql === 'ROLLBACK') {
      this.restoreSnapshot();
      return ok<R>([]);
    }

    const maybeThrow = (): void => {
      this.writeCount += 1;
      if (this.throwAfterWrites !== null && this.writeCount >= this.throwAfterWrites) {
        this.throwAfterWrites = null;
        throw new Error('injected db failure mid-transaction');
      }
    };

    // —— readVersionForPublish（JOIN capabilities + users）——
    if (
      sql.includes('FROM capability_versions v') &&
      sql.includes('JOIN capabilities c') &&
      sql.includes('JOIN users u') &&
      sql.includes('c.current_version_id')
    ) {
      const v = this.versions.get(params[0] as string);
      if (!v) return ok<R>([]);
      const c = this.capabilities.get(v.capability_id)!;
      const u = this.users.get(c.creator_user_id)!;
      return ok<R>([
        {
          version_id: v.id,
          capability_id: v.capability_id,
          slug: c.slug,
          status: v.status,
          manifest: v.manifest,
          creator_user_id: c.creator_user_id,
          account: u.account,
          current_version_id: c.current_version_id,
        },
      ] as R[]);
    }

    // —— readFrozenTiers（SELECT tier_code, price_micros FROM capability_tiers WHERE version_id ORDER BY tier_code）——
    if (
      sql.includes('SELECT tier_code, price_micros') &&
      sql.includes('FROM capability_tiers') &&
      sql.includes('WHERE version_id = $1')
    ) {
      const vid = params[0] as string;
      const rows = this.tiers
        .filter((t) => t.version_id === vid)
        .sort((a, b) => (a.tier_code < b.tier_code ? -1 : 1))
        .map((t) => ({ tier_code: t.tier_code, price_micros: t.price_micros }));
      return ok<R>(rows as R[]);
    }

    // —— ① 发布门事务内锁 capability 行 + 重读 current_version_id（FOR UPDATE，Codex#4）——
    if (sql.includes('SELECT current_version_id FROM capabilities') && sql.includes('FOR UPDATE')) {
      const cap = this.capabilities.get(params[0] as string);
      if (!cap) return ok<R>([]);
      return ok<R>([{ current_version_id: cap.current_version_id }] as R[]);
    }

    // —— 评审事务内统一锁序：先锁 capability 行（SELECT id ... FOR UPDATE，Codex r2 防死锁）——
    if (sql.includes('SELECT id FROM capabilities') && sql.includes('FOR UPDATE')) {
      const cap = this.capabilities.get(params[0] as string);
      if (!cap) return ok<R>([]);
      return ok<R>([{ id: cap.id }] as R[]);
    }

    // —— ② 守门 UPDATE：本 draft → published + 版本级冻结 manifest_hash/封面/可见性（WHERE id AND status='draft'）——
    if (
      sql.includes('UPDATE capability_versions') &&
      sql.includes("status = 'published'") &&
      sql.includes("status = 'draft'")
    ) {
      maybeThrow();
      const v = this.versions.get(params[0] as string);
      if (!v || v.status !== 'draft') return ok<R>([], 0); // 非 draft → 0 行（防重核心）
      v.status = 'published';
      v.manifest_hash = params[1] as string;
      // 封面三来源 + 可见性同事务版本级冻结（r3 P1）。
      v.cover_source = (params[2] as string) ?? null;
      v.cover_asset_key = (params[3] as string) ?? null;
      v.cover_snapshot_ref = (params[4] as string) ?? null;
      v.visibility = (params[5] as string) ?? null;
      return ok<R>([], 1);
    }

    // —— ③ INSERT capability_tiers ON CONFLICT DO NOTHING ——
    if (sql.includes('INSERT INTO capability_tiers')) {
      maybeThrow();
      const versionId = params[0] as string;
      const tierCode = params[1] as string;
      const priceMicros = Number(params[2]);
      const exists = this.tiers.find((t) => t.version_id === versionId && t.tier_code === tierCode);
      if (exists) return ok<R>([], 0); // ON CONFLICT DO NOTHING：已冻结价不回写
      this.tiers.push({ version_id: versionId, tier_code: tierCode, price_micros: priceMicros });
      return ok<R>([], 1);
    }

    // —— ④ 旧版滚动 superseded（SET status='superseded' WHERE id AND capability_id AND status='published'）——
    if (
      sql.includes('UPDATE capability_versions') &&
      sql.includes("SET status = 'superseded'") &&
      sql.includes("status = 'published'")
    ) {
      maybeThrow();
      const v = this.versions.get(params[0] as string);
      const capId = params[1] as string;
      if (!v || v.capability_id !== capId || v.status !== 'published') return ok<R>([], 0);
      v.status = 'superseded';
      return ok<R>([], 1);
    }

    // —— ⑤ upsert publications ON CONFLICT (capability_id) ——
    if (sql.includes('INSERT INTO publications') && sql.includes('ON CONFLICT (capability_id)')) {
      maybeThrow();
      const capId = params[0] as string;
      const versionId = params[1] as string;
      const shareToken = params[2] as string;
      const visibility = params[3] as string;
      const existing = this.publications.get(capId);
      if (existing) {
        // ON CONFLICT DO UPDATE：share_token COALESCE 保留既有（私享链接稳定）。
        existing.current_version_id = versionId;
        existing.visibility = visibility;
        existing.review_status = 'alpha_pending';
        existing.reject_reason = null;
      } else {
        this.publications.set(capId, {
          capability_id: capId,
          current_version_id: versionId,
          share_token: shareToken,
          visibility,
          review_status: 'alpha_pending',
          reject_reason: null,
        });
      }
      return ok<R>([], 1);
    }

    // —— 回读 share_token ——
    if (sql.includes('SELECT share_token FROM publications WHERE capability_id = $1')) {
      const p = this.publications.get(params[0] as string);
      return ok<R>(p ? ([{ share_token: p.share_token }] as R[]) : []);
    }

    // —— ⑥ capabilities.current_version_id → 本版 ——
    if (
      sql.includes('UPDATE capabilities') &&
      sql.includes('current_version_id = $2') &&
      sql.includes('WHERE id = $1')
    ) {
      maybeThrow();
      const cap = this.capabilities.get(params[0] as string);
      if (!cap) return ok<R>([], 0);
      cap.current_version_id = params[1] as string;
      return ok<R>([], 1);
    }

    // —— ⑦ emitInTx：INSERT outbox_events ON CONFLICT (event_id) DO NOTHING RETURNING seq ——
    if (sql.includes('INSERT INTO outbox_events') && sql.includes('ON CONFLICT (event_id)')) {
      maybeThrow();
      const eventId = params[0] as string;
      const topic = params[1] as string;
      const aggregateId = params[2] as string;
      const payload = JSON.parse(params[3] as string);
      const traceId = (params[4] as string) ?? null;
      if (this.outbox.find((o) => o.event_id === eventId)) {
        return ok<R>([], 0); // ON CONFLICT DO NOTHING：同事件不重复
      }
      const seq = ++this.outboxSeq;
      this.outbox.push({
        seq,
        event_id: eventId,
        topic,
        aggregate_id: aggregateId,
        payload,
        trace_id: traceId,
      });
      return ok<R>([{ seq }] as R[], 1);
    }

    // —— 评审事务内 FOR UPDATE 重读 publication（current_version_id + review_status，Codex#3）——
    if (
      sql.includes('SELECT current_version_id, review_status') &&
      sql.includes('FROM publications') &&
      sql.includes('FOR UPDATE')
    ) {
      const pub = this.publications.get(params[0] as string);
      if (!pub) return ok<R>([]);
      return ok<R>([
        { current_version_id: pub.current_version_id, review_status: pub.review_status },
      ] as R[]);
    }

    // —— readPublicationForReview（publications JOIN capabilities + 被裁决版 hash + LATERAL 上一 superseded 版）——
    if (
      sql.includes('FROM publications p') &&
      sql.includes('cur.manifest_hash') &&
      sql.includes("s.status = 'superseded'")
    ) {
      const pub = this.publications.get(params[0] as string);
      if (!pub) return ok<R>([]);
      const cap = this.capabilities.get(pub.capability_id)!;
      const cur = this.versions.get(pub.current_version_id)!;
      // 上一 superseded 版（按 updated_at 倒序取最近一条，本期至多一条活跃血缘）。
      const prev = [...this.versions.values()]
        .filter((v) => v.capability_id === pub.capability_id && v.status === 'superseded')
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
      return ok<R>([
        {
          capability_id: pub.capability_id,
          current_version_id: pub.current_version_id,
          slug: cap.slug,
          review_status: pub.review_status,
          owner_user_id: cap.creator_user_id,
          manifest_hash: cur.manifest_hash,
          prev_version_id: prev?.id ?? null,
          prev_manifest_hash: prev?.manifest_hash ?? null,
          prev_visibility: prev?.visibility ?? null,
        },
      ] as R[]);
    }

    // —— readPublicationView（publications JOIN capabilities + LATERAL 最近一条 review_rejected 版）——
    if (
      sql.includes('FROM publications p') &&
      sql.includes('p.share_token') &&
      sql.includes("r.status = 'review_rejected'")
    ) {
      const pub = this.publications.get(params[0] as string);
      if (!pub) return ok<R>([]);
      const cap = this.capabilities.get(pub.capability_id)!;
      const rej = [...this.versions.values()]
        .filter((v) => v.capability_id === pub.capability_id && v.status === 'review_rejected')
        .sort((a, b) => (b.rejected_at ?? '').localeCompare(a.rejected_at ?? ''))[0];
      return ok<R>([
        {
          capability_id: pub.capability_id,
          current_version_id: pub.current_version_id,
          slug: cap.slug,
          share_token: pub.share_token,
          visibility: pub.visibility,
          review_status: pub.review_status,
          reject_reason: pub.reject_reason,
          reviewed_at: pub.reviewed_at ?? null,
          published_at: pub.published_at ?? '2026-06-16T00:00:00.000Z',
          owner_user_id: cap.creator_user_id,
          rejected_version_id: rej?.id ?? null,
          rejected_at: rej?.rejected_at ?? null,
        },
      ] as R[]);
    }

    // —— 评审 approve 守门 UPDATE publications（review_status='published' WHERE alpha_pending AND current=$2）——
    //    SET 不含 current_version_id（approve 当前版不变）；WHERE 守 current_version_id=$2=reviewedVersionId（Codex#3）。
    //    与回退路径区分：approve 不含 reject_reason 镜像（回退/下架两路都镜像 reject_reason）。
    if (
      sql.includes('UPDATE publications') &&
      sql.includes("review_status = 'published'") &&
      !sql.includes('reject_reason') && // 区分回退路径（那条 SET reject_reason=$3）
      sql.includes("review_status = 'alpha_pending'")
    ) {
      maybeThrow();
      const pub = this.publications.get(params[0] as string);
      // 守门：已裁决 或 并发新版发布把 current 推走 → 0 行（不裁错版，Codex#3）。
      if (
        !pub ||
        pub.review_status !== 'alpha_pending' ||
        pub.current_version_id !== (params[1] as string)
      )
        return ok<R>([], 0);
      pub.review_status = 'published';
      pub.reviewed_at = '2026-06-16T00:00:00.000Z';
      return ok<R>([], 1);
    }

    // —— 评审 reject 回退 UPDATE publications（SET current=$2 回退 + published + reject_reason=$3；WHERE current=$4 守门）——
    if (
      sql.includes('UPDATE publications') &&
      sql.includes('current_version_id = $2') &&
      sql.includes("review_status = 'published'") &&
      sql.includes("review_status = 'alpha_pending'")
    ) {
      maybeThrow();
      const pub = this.publications.get(params[0] as string);
      // 守门：alpha_pending + current=被裁决版（$4=reviewedVersionId）→ 否则 0 行（Codex#3）。
      if (
        !pub ||
        pub.review_status !== 'alpha_pending' ||
        pub.current_version_id !== (params[3] as string)
      )
        return ok<R>([], 0);
      pub.current_version_id = params[1] as string;
      pub.review_status = 'published';
      pub.reject_reason = params[2] as string;
      // 还原可见性为上一版冻结值（被展示版自身值，r3 P1）；param[4]=$5=prevVisibility（兜 public）。
      pub.visibility = (params[4] as string) ?? 'public';
      pub.reviewed_at = '2026-06-16T00:00:00.000Z';
      return ok<R>([], 1);
    }

    // —— 评审 reject 下架 UPDATE publications（review_status='review_rejected' + reject_reason=$2；WHERE current=$3 守门）——
    if (
      sql.includes('UPDATE publications') &&
      sql.includes("review_status = 'review_rejected'") &&
      sql.includes("review_status = 'alpha_pending'")
    ) {
      maybeThrow();
      const pub = this.publications.get(params[0] as string);
      // 守门：alpha_pending + current=被裁决版（$3=reviewedVersionId）→ 否则 0 行（Codex#3）。
      if (
        !pub ||
        pub.review_status !== 'alpha_pending' ||
        pub.current_version_id !== (params[2] as string)
      )
        return ok<R>([], 0);
      pub.review_status = 'review_rejected';
      pub.reject_reason = params[1] as string;
      pub.reviewed_at = '2026-06-16T00:00:00.000Z';
      return ok<R>([], 1);
    }

    // —— 被拒版本线：UPDATE capability_versions status='review_rejected'（WHERE id AND status='published'）——
    if (
      sql.includes('UPDATE capability_versions') &&
      sql.includes("status = 'review_rejected'") &&
      sql.includes("status = 'published'")
    ) {
      maybeThrow();
      const v = this.versions.get(params[0] as string);
      if (!v || v.status !== 'published') return ok<R>([], 0);
      v.status = 'review_rejected';
      v.reject_reason = params[1] as string;
      v.rejected_at = '2026-06-16T00:00:00.000Z';
      return ok<R>([], 1);
    }

    // —— 上一版复位：UPDATE capability_versions status='published'（WHERE id AND capability_id AND status='superseded'）——
    if (
      sql.includes('UPDATE capability_versions') &&
      sql.includes("status = 'published'") &&
      sql.includes("status = 'superseded'")
    ) {
      maybeThrow();
      const v = this.versions.get(params[0] as string);
      const capId = params[1] as string;
      if (!v || v.capability_id !== capId || v.status !== 'superseded') return ok<R>([], 0);
      v.status = 'published';
      return ok<R>([], 1);
    }

    throw new Error(`PublishFakeDb: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  /** Pool.connect（供 asTxPool）：复用本库 query（事务记账已在 query 内按 BEGIN/COMMIT/ROLLBACK 处理）。 */
  async connect(): Promise<{ query: Queryable['query']; release: () => void }> {
    return { query: this.query.bind(this) as Queryable['query'], release: () => undefined };
  }
}

// —— 播种 helpers ——

/** 已生成软字段齐全的 manifest（name/tagline/goal 非空，可发布）。 */
export function readyManifest(capabilityId: string, version = '0.1.0'): Manifest {
  return applySoftFields(initialManifest(capabilityId, version), {
    name: '需求炼金师',
    tagline: '把对话炼成可复用的能力',
    role: '产品分析助手',
    goal: '从会话提炼 PRD 结构',
    instructions: '根据 {{topic}} 生成结构化产物',
    skill_set: ['需求拆解'],
    starter_prompts: ['帮我把这段对话整理成 PRD'],
  });
}

export function seedUser(db: PublishFakeDb, account = 'WAYNE'): string {
  const id = genId('user');
  db.users.set(id, { id, account });
  return id;
}

export function seedCapabilityVersion(
  db: PublishFakeDb,
  ownerUserId: string,
  opts?: {
    status?: string;
    manifest?: Manifest;
    isCurrent?: boolean;
    slug?: string;
    version?: string;
  },
): { capabilityId: string; versionId: string; slug: string } {
  const capabilityId = genId('cap');
  const versionId = genId('ver');
  const slug = opts?.slug ?? `slug-${capabilityId}`;
  const version = opts?.version ?? '0.1.0';
  const manifest = opts?.manifest ?? readyManifest(capabilityId, version);
  db.capabilities.set(capabilityId, {
    id: capabilityId,
    creator_user_id: ownerUserId,
    slug,
    current_version_id: opts?.isCurrent ? versionId : null,
  });
  db.versions.set(versionId, {
    id: versionId,
    capability_id: capabilityId,
    version,
    status: opts?.status ?? 'draft',
    manifest,
    manifest_hash: null,
  });
  return { capabilityId, versionId, slug };
}
