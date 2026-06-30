// 40 · B-24 建能力体 draft 版本（三分支恰好三选一，40-step3-4-structure §4.A / §2.4）。
//   ① sourceCandidateId：从候选新建首版（capabilities + capability_versions，单 PG 事务）。
//   ② capabilityId：published 后建新版本（复用能力体、bump minor、status=draft）。
//   ③ fromVersionId：被拒重发派生新 draft（同能力体复制被拒版软字段、bump minor，原被拒版不动，§2.4 / 50 §1.1 F-14）。
//   幂等：同 key + 同 hash + 已完成 → 回放首次结果（中间件 requireIdempotency 兜，本模块产稳定结果即可，§4.A 幂等回放）。
//   slug 服务端从候选名/能力名生成（URL 安全、唯一、不可变，不由客户端传，§4.A 注）。
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  slugify,
  type CreateCapabilityBody,
  type CreateCapabilityResult,
  type Manifest,
} from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import { withTransaction } from '../../platform/events/db-tx.js';
import { initialManifest, initialStructureState, applySoftFields } from './manifest.js';
import {
  readCandidateForCreate,
  readCapabilityForNewVersion,
  readVersion,
  createCapabilityWithVersionInTx,
  insertNewVersionInTx,
  backfillDraftInTx,
} from './repo.js';

/**
 * 业务错误（带 code，路由层据 code → HTTP + 人话信封；§4.A 错误用例）。
 *   可选 `overrides`（userMessage/action）：用于个别用例需在分类表缺省之上给更贴切的人话/退路
 *   （如「重复创建」走 409 STATE_CONFLICT 但人话应是「这个能力已经创建过了」、不可重试）。路由层透传，对外仍不含 code（D1）。
 */
export class CreateCapabilityError extends Error {
  constructor(
    public code: (typeof ErrorCode)[keyof typeof ErrorCode],
    message: string,
    public overrides?: {
      userMessage?: string;
      action?: 'retry' | 'change_input' | 'escalate' | 'wait' | 'none';
    },
  ) {
    super(message);
    this.name = 'CreateCapabilityError';
  }
}

/**
 * 判定 PG 错误是否为 capabilities.slug 唯一键冲突（uq_capabilities_slug，code=23505，BUG-2）。
 *   触发于「同一候选重复 POST /capabilities」：CJK 候选名 slugify 回退成 cap-{hash(sourceCandidateId)}，
 *   同候选两次产同 slug，第二次 INSERT 撞 uq_capabilities_slug。映射成干净的 409 冲突（非 503、不可重试），
 *   语义即「这个能力已经创建过了」。
 *   仅认精确约束名或 message 显式含 uq_capabilities_slug（Codex 收紧）：同事务还会触发别的唯一约束
 *   （capabilities.id / capability_versions.id / uq_capability_version / uq_capability_versions_capability_id 等），
 *   绝不能因「确是 23505」就一概当 slug 冲突——空 constraint/message 兜底已删除，其它 23505 继续走原 DB 异常路径（503）。
 */
export function isCapabilitySlugConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  const constraint = typeof e.constraint === 'string' ? e.constraint : '';
  const message = typeof e.message === 'string' ? e.message : '';
  // 只接受精确约束名命中，或 message 完整词命中 uq_capabilities_slug（\b 防 uq_capabilities_slug2 等前后缀误判）。
  return constraint === 'uq_capabilities_slug' || /\buq_capabilities_slug\b/.test(message);
}

/**
 * 同事务后置钩子（Codex r7 P1 原子窗口修，仅 sourceCandidateId 分支用，批编排注入）。
 *   在建体 INSERT 之后、本事务 COMMIT 之前【同 tx】被调，让调用方把「依赖新 versionId 的受保护写」（如批 item.version_id 回填）
 *   合进【同一事务】：返回 false（fence 校验未命中/被接管）→ createCapability 抛 BackfillFencedError 回滚整事务（建体一并回滚，
 *   version 未提交），关掉「已提交 version 但 item 无指针」的窗口（重试据 candidate 重建、不重复建版）。
 *   返回 true → 钩子的写与建体同 COMMIT。钩子内须只用传入的 tx 句柄（同一连接 = 同一事务），不可另取连接。
 */
export type OnCreatedInTx = (
  tx: Tx,
  created: { versionId: string; capabilityId: string },
) => Promise<boolean>;

/** createCapability 可选项（onCreatedInTx：同事务后置钩子，原子合入依赖新版本的受保护写）。 */
export interface CreateCapabilityOptions {
  onCreatedInTx?: OnCreatedInTx;
}

/**
 * onCreatedInTx 返回 false 的内部回滚信号（fence 校验未命中/被接管）：用于把建体事务整体回滚。
 *   不外泄给调用方——createFromCandidate 捕获它，转成「fencedOut」语义（CreateCapabilityError(STATE_CONFLICT)），
 *   批编排据此走 fencedOut 收口（安全退出本项，无残留半版）。
 */
class BackfillFencedError extends Error {
  constructor() {
    super('onCreatedInTx fenced out');
    this.name = 'BackfillFencedError';
  }
}

/** 区分「create 因后置回填被 fence out」与真正建体失败（批编排据此走 fencedOut 而非 failed）。 */
export class CreateCapabilityFencedError extends Error {
  constructor() {
    super('create-capability fenced out (backfill guard not satisfied)');
    this.name = 'CreateCapabilityFencedError';
  }
}

/** 首版 semver（§2.4：首版 draft = 0.1.0）。 */
export const INITIAL_VERSION = '0.1.0';

/**
 * bump minor（published 后新 draft / 被拒派生新 draft，§2.4）。
 *   '0.1.0' → '0.2.0'；坏版本号兜底从 0.1.0 起（不抛，保证总能产出合法 draft）。
 */
export function bumpMinor(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return INITIAL_VERSION;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return `${major}.${minor + 1}.0`;
}

/**
 * 建能力体 draft 版本（三分支；入参已过 zod「恰好三选一」refine，本模块再按存在的那个字段分流）。
 *   注：恰好三选一的【格式】校验在路由层 CreateCapabilityBodySchema.refine；本模块假定入参合法，按字段分流并做【业务态】校验
 *       （候选/能力体/被拒版的存在性、属主、状态机门禁，§4.A 错误用例）。
 */
export async function createCapability(
  db: Queryable,
  txPool: TxPool,
  body: CreateCapabilityBody,
  ctx: { userId: string },
  opts?: CreateCapabilityOptions,
): Promise<CreateCapabilityResult> {
  if (body.sourceCandidateId) {
    return createFromCandidate(db, txPool, body.sourceCandidateId, body.draftId, ctx, opts);
  }
  if (body.capabilityId) {
    return createNewVersion(db, txPool, body.capabilityId, body.draftId, ctx);
  }
  if (body.fromVersionId) {
    return createFromRejected(db, txPool, body.fromVersionId, body.draftId, ctx);
  }
  // 理论不可达（zod 已挡零个）；防御性 422。
  throw new CreateCapabilityError(
    ErrorCode.VALIDATION_FAILED,
    'exactly one of sourceCandidateId/capabilityId/fromVersionId required',
  );
}

/** ① 从候选新建首版（§4.A）。 */
async function createFromCandidate(
  db: Queryable,
  txPool: TxPool,
  sourceCandidateId: string,
  draftId: string | undefined,
  ctx: { userId: string },
  opts?: CreateCapabilityOptions,
): Promise<CreateCapabilityResult> {
  const cand = await readCandidateForCreate(db, sourceCandidateId, ctx.userId);
  if (!cand) {
    throw new CreateCapabilityError(ErrorCode.NOT_FOUND, 'candidate not found / not owner');
  }

  const capabilityId = randomUUID();
  const versionId = randomUUID();
  // slug 服务端从候选名生成（URL 安全、唯一、不可变）；候选名空 → 用候选 slug 种子兜底。
  const slug = slugify(cand.name ?? cand.slug, `${sourceCandidateId}`);
  const version = INITIAL_VERSION;
  const manifest = initialManifest(capabilityId, version);
  const structureState = initialStructureState(versionId, manifest);

  try {
    await withTransaction(txPool, async (tx) => {
      await createCapabilityWithVersionInTx(tx, {
        capabilityId,
        versionId,
        creatorUserId: ctx.userId,
        slug,
        version,
        manifest,
        structureState,
        sourceCandidateId,
      });
      if (draftId) {
        const ok = await backfillDraftInTx(tx, {
          draftId,
          versionId,
          capabilityId,
          ownerUserId: ctx.userId,
          selection: { mode: 'single', candidateId: sourceCandidateId },
        });
        // 0 行 = draft 不存在 / 非本人 / 非 active → 抛错回滚整事务（不建能力体，杜绝覆盖他人草稿，Codex P0-2）。
        if (!ok) {
          throw new CreateCapabilityError(
            ErrorCode.NOT_FOUND,
            'draft not found / not owner / inactive',
          );
        }
      }
      // 同事务后置钩子（Codex r7 P1 原子窗口修）：批编排把「item.version_id 受保护回填」合进【本事务】。
      //   建体 INSERT 已落但未 COMMIT；钩子在同 tx 内 fence 校验 + 回填，0 行（被接管/换 fence）→ 返回 false →
      //   抛 BackfillFencedError 回滚整事务（建体一并回滚，version 未提交）。如此「建版+回填」原子，无「已提交 version 但 item 无指针」窗口。
      if (opts?.onCreatedInTx) {
        const ok = await opts.onCreatedInTx(tx, { versionId, capabilityId });
        if (!ok) throw new BackfillFencedError();
      }
    });
  } catch (err) {
    // 后置回填 fence out（被接管）→ 整事务已回滚（version 未提交）；转 CreateCapabilityFencedError 让批编排走 fencedOut 收口。
    if (err instanceof BackfillFencedError) throw new CreateCapabilityFencedError();
    // 同候选重复创建（slug 撞 uq_capabilities_slug，BUG-2）→ 干净 409 冲突（非 503、不可重试）：原始 PG 唯一冲突
    //   不再落到 handler catch-all 被误判成「系统正在恢复」可重试。语义即「这个能力已经创建过了」。
    if (isCapabilitySlugConflict(err)) {
      throw new CreateCapabilityError(
        ErrorCode.STATE_CONFLICT,
        'capability already created for this candidate (slug conflict)',
        { userMessage: '这个能力已经创建过了，去工作台查看即可。', action: 'none' },
      );
    }
    throw err;
  }

  return result(capabilityId, versionId, slug, version, manifest);
}

/** ② published 后建新版本（capabilityId，bump minor，§2.4 / §4.A）。 */
async function createNewVersion(
  db: Queryable,
  txPool: TxPool,
  capabilityId: string,
  draftId: string | undefined,
  ctx: { userId: string },
): Promise<CreateCapabilityResult> {
  const cap = await readCapabilityForNewVersion(db, capabilityId, ctx.userId);
  if (!cap) {
    throw new CreateCapabilityError(ErrorCode.NOT_FOUND, 'capability not found / not owner');
  }
  // §4.A：capabilityId 分支需【已发布】版本（当前生效版 published 才允许 bump 新 draft）。
  if (cap.currentVersionStatus !== 'published') {
    throw new CreateCapabilityError(
      ErrorCode.STATE_CONFLICT,
      'capabilityId branch requires published current version',
    );
  }
  const versionId = randomUUID();
  const version = bumpMinor(cap.currentVersion ?? INITIAL_VERSION);
  // 新版本软字段空（重新结构化）；硬字段重锁。slug 不变（沿用能力体）。
  const manifest = initialManifest(capabilityId, version);
  const structureState = initialStructureState(versionId, manifest);

  await withTransaction(txPool, async (tx) => {
    await insertNewVersionInTx(tx, {
      capabilityId,
      versionId,
      version,
      manifest,
      structureState,
      sourceCandidateId: null,
    });
    if (draftId) {
      const ok = await backfillDraftInTx(tx, {
        draftId,
        versionId,
        capabilityId,
        ownerUserId: ctx.userId,
        selection: { mode: 'single', candidateId: capabilityId }, // 衔接：续传读回（无候选血缘，记能力体）。
      });
      if (!ok) {
        throw new CreateCapabilityError(
          ErrorCode.NOT_FOUND,
          'draft not found / not owner / inactive',
        );
      }
    }
  });

  return result(capabilityId, versionId, cap.slug, version, manifest);
}

/** ③ 被拒重发派生新 draft（fromVersionId，复制软字段、bump minor，§2.4 / 50 §1.1 F-14）。 */
async function createFromRejected(
  db: Queryable,
  txPool: TxPool,
  fromVersionId: string,
  draftId: string | undefined,
  ctx: { userId: string },
): Promise<CreateCapabilityResult> {
  const src = await readVersion(db, fromVersionId);
  if (!src) {
    throw new CreateCapabilityError(ErrorCode.NOT_FOUND, 'fromVersion not found');
  }
  // 属主校验（经 capabilities.creator_user_id）。
  if (src.creatorUserId !== ctx.userId) {
    throw new CreateCapabilityError(ErrorCode.FORBIDDEN, 'fromVersion not owner');
  }
  // §2.4：源版必须恰为 review_rejected（非被拒态 → STATE_CONFLICT）。首发被拒也走此路径（不要求存在 published 版）。
  if (src.status !== 'review_rejected') {
    throw new CreateCapabilityError(
      ErrorCode.STATE_CONFLICT,
      'fromVersion must be review_rejected',
    );
  }

  const versionId = randomUUID();
  const version = bumpMinor(src.version);
  // 复制被拒版【软字段】为起点；硬字段按平台规则重锁（id=capabilityId、version=bump、status=draft）。
  const manifest = copySoftFieldsToNewVersion(src.manifest, src.capabilityId, version);
  const structureState = initialStructureState(versionId, manifest);

  await withTransaction(txPool, async (tx) => {
    await insertNewVersionInTx(tx, {
      capabilityId: src.capabilityId,
      versionId,
      version,
      manifest,
      structureState,
      // 血缘沿用源被拒版（可空，§4.A）。
      sourceCandidateId: src.sourceCandidateId,
    });
    if (draftId) {
      const ok = await backfillDraftInTx(tx, {
        draftId,
        versionId,
        capabilityId: src.capabilityId,
        ownerUserId: ctx.userId,
        selection: { mode: 'single', candidateId: src.sourceCandidateId ?? src.capabilityId },
      });
      if (!ok) {
        throw new CreateCapabilityError(
          ErrorCode.NOT_FOUND,
          'draft not found / not owner / inactive',
        );
      }
    }
  });

  return result(src.capabilityId, versionId, src.slug, version, manifest);
}

/** 复制源 manifest 软字段到新版本（硬字段重锁，§2.4）。 */
function copySoftFieldsToNewVersion(
  srcManifest: Manifest,
  capabilityId: string,
  version: string,
): Manifest {
  const base = initialManifest(capabilityId, version); // 硬字段重锁（id/version/status/boundaries）。
  // applySoftFields 落软字段并据 instructions 重算 inputs/output（系统派生、仍锁定，§4.E）。
  return applySoftFields(base, {
    name: srcManifest.name ?? '',
    tagline: srcManifest.tagline ?? '',
    role: srcManifest.role ?? '',
    goal: srcManifest.goal ?? '',
    instructions: srcManifest.instructions ?? '',
    skill_set: Array.isArray(srcManifest.skill_set) ? [...srcManifest.skill_set] : [],
    starter_prompts: Array.isArray(srcManifest.starter_prompts)
      ? [...srcManifest.starter_prompts]
      : [],
  });
}

function result(
  capabilityId: string,
  versionId: string,
  slug: string,
  version: string,
  manifest: Manifest,
): CreateCapabilityResult {
  return {
    capabilityId,
    versionId,
    slug,
    version,
    manifest,
    structureState: initialStructureState(versionId, manifest),
  };
}
