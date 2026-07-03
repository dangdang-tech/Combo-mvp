import {
  SOFT_FIELD_KEYS,
  ErrorCode,
  buildError,
  type ErrorBody,
  type LlmGatewayPort,
  type Manifest,
  type SoftFieldKey,
} from '@cb/shared';
import type { Queryable } from '../../platform/jobs/types.js';
import { withTransaction, type Tx, type TxPool } from '../../platform/events/db-tx.js';
import {
  createCapability,
  CreateCapabilityError,
  CreateCapabilityFencedError,
} from './create-capability.js';
import {
  readDraftVersionForCandidate,
  readEvidenceForCandidate,
  readCandidateForCreate,
  readVersion,
  writeManifestAndStateProtected,
} from './repo.js';
import {
  applySoftField,
  applySoftFields,
  isArrayField,
  manifestToStructureState,
} from './manifest.js';
import { generateFieldWithRetry, type GenContext } from './generate.js';

export type CandidateDraftPreparationOutcome =
  | { kind: 'ready'; capabilityId: string; versionId: string; slug: string }
  | { kind: 'failed'; error: ErrorBody; missingFields: string[] | null; versionId?: string }
  | { kind: 'fencedOut' };

export interface CandidateDraftPreparationDeps {
  db: Queryable;
  txPool: TxPool;
  gateway: LlmGatewayPort;
}

export type OnVersionPreparedInTx = (
  tx: Tx,
  args: { versionId: string; capabilityId?: string },
) => Promise<boolean>;

export async function prepareCandidateDraft(
  deps: CandidateDraftPreparationDeps,
  args: {
    candidateId: string;
    ownerUserId: string;
    jobId: string;
    fenceToken: number;
    traceId: string;
    existingVersionId?: string;
    onVersionPreparedInTx?: OnVersionPreparedInTx;
  },
): Promise<CandidateDraftPreparationOutcome> {
  const { db, txPool } = deps;
  let versionId = args.existingVersionId;

  if (!versionId) {
    const existing = await readDraftVersionForCandidate(db, {
      candidateId: args.candidateId,
      ownerUserId: args.ownerUserId,
    });
    if (existing) {
      versionId = existing.id;
      if (args.onVersionPreparedInTx) {
        try {
          await withTransaction(txPool, async (tx) => {
            const ok = await args.onVersionPreparedInTx!(tx, {
              versionId: existing.id,
              capabilityId: existing.capabilityId,
            });
            if (!ok) throw new CreateCapabilityFencedError();
          });
        } catch (err) {
          if (err instanceof CreateCapabilityFencedError) return { kind: 'fencedOut' };
          return {
            kind: 'failed',
            error: createCapabilityErrorBody(err, args.traceId),
            missingFields: null,
          };
        }
      }
    }
  }

  if (!versionId) {
    try {
      const created = await createCapability(
        db,
        txPool,
        { sourceCandidateId: args.candidateId },
        { userId: args.ownerUserId },
        args.onVersionPreparedInTx
          ? {
              onCreatedInTx: async (tx, c) =>
                args.onVersionPreparedInTx!(tx, {
                  versionId: c.versionId,
                  capabilityId: c.capabilityId,
                }),
            }
          : undefined,
      );
      versionId = created.versionId;
    } catch (err) {
      if (err instanceof CreateCapabilityFencedError) return { kind: 'fencedOut' };
      return {
        kind: 'failed',
        error: createCapabilityErrorBody(err, args.traceId),
        missingFields: null,
      };
    }
  }

  const structured = await fillCandidateDraftSoftFields(deps, {
    versionId,
    ownerUserId: args.ownerUserId,
    jobId: args.jobId,
    fenceToken: args.fenceToken,
    traceId: args.traceId,
  });
  if (structured.kind === 'fencedOut') return { kind: 'fencedOut' };
  if (structured.kind === 'failed') {
    return {
      kind: 'failed',
      error: structured.error,
      missingFields: structured.missingFields,
      versionId,
    };
  }
  return {
    kind: 'ready',
    versionId,
    capabilityId: structured.capabilityId,
    slug: structured.slug,
  };
}

async function fillCandidateDraftSoftFields(
  deps: CandidateDraftPreparationDeps,
  args: {
    versionId: string;
    ownerUserId: string;
    jobId: string;
    fenceToken: number;
    traceId: string;
  },
): Promise<
  | { kind: 'done'; manifest: Manifest; capabilityId: string; slug: string }
  | { kind: 'failed'; error: ErrorBody; missingFields: string[] | null }
  | { kind: 'fencedOut' }
> {
  const { db, gateway } = deps;
  const version = await readVersion(db, args.versionId);
  if (!version) return { kind: 'failed', error: notFoundBody(args.traceId), missingFields: null };
  if (version.creatorUserId !== args.ownerUserId || version.status !== 'draft') {
    return { kind: 'failed', error: notFoundBody(args.traceId), missingFields: null };
  }

  let manifest = version.manifest;
  if (version.sourceCandidateId) {
    const candidate = await readCandidateForCreate(db, version.sourceCandidateId, args.ownerUserId);
    if (candidate) manifest = seedCandidateSoftFields(manifest, candidate);
  }

  if (SOFT_FIELD_KEYS.every((f) => hasValue(manifest, f))) {
    return {
      kind: 'done',
      manifest,
      capabilityId: version.capabilityId,
      slug: version.slug,
    };
  }

  let evidence = {
    segments: [] as Awaited<ReturnType<typeof readEvidenceForCandidate>>['segments'],
  };
  if (version.sourceCandidateId) {
    evidence = await readEvidenceForCandidate(db, version.sourceCandidateId);
  }
  if (evidence.segments.length === 0) {
    return { kind: 'failed', error: noEvidenceBody(args.traceId), missingFields: null };
  }

  for (const field of SOFT_FIELD_KEYS) {
    if (hasValue(manifest, field)) continue;
    const genCtx: GenContext = {
      generated: softGenerated(manifest),
      evidence,
      traceId: args.traceId,
      ownerUserId: args.ownerUserId,
    };
    const gen = await generateFieldWithRetry(gateway, field, genCtx, {
      onAttemptStart: async () => {},
      onScalarDelta: async () => {},
      onArrayItem: async () => {},
    });
    if (gen.kind === 'failed' && gen.terminal) {
      return {
        kind: 'failed',
        error: structureFieldFailedBody(args.traceId, field),
        missingFields: [field],
      };
    }
    if (gen.kind === 'ok') {
      manifest = applySoftField(manifest, field, gen.result.value);
    } else {
      const fallback = await fallbackField(deps, field, manifest, evidence, args);
      manifest = applySoftField(manifest, field, fallback);
    }
  }

  const state = manifestToStructureState(args.versionId, manifest);
  const wrote = await writeManifestAndStateProtected(db, {
    jobId: args.jobId,
    fenceToken: args.fenceToken,
    versionId: args.versionId,
    manifest,
    state,
  });
  if (!wrote) return { kind: 'fencedOut' };

  return { kind: 'done', manifest, capabilityId: version.capabilityId, slug: version.slug };
}

async function fallbackField(
  deps: CandidateDraftPreparationDeps,
  field: SoftFieldKey,
  manifest: Manifest,
  evidence: { segments: Awaited<ReturnType<typeof readEvidenceForCandidate>>['segments'] },
  args: { ownerUserId: string; traceId: string },
): Promise<string | string[]> {
  const genCtx: GenContext = {
    generated: softGenerated(manifest),
    evidence,
    traceId: args.traceId,
    ownerUserId: args.ownerUserId,
  };
  const gen = await generateFieldWithRetry(deps.gateway, field, genCtx, {
    onAttemptStart: async () => {},
    onScalarDelta: async () => {},
    onArrayItem: async () => {},
  });
  if (gen.kind === 'ok') return gen.result.value;
  return isArrayField(field) ? [] : '';
}

function hasValue(manifest: Manifest, field: SoftFieldKey): boolean {
  const v = manifest[field];
  return isArrayField(field)
    ? Array.isArray(v) && v.length > 0
    : typeof v === 'string' && v.length > 0;
}

function seedCandidateSoftFields(
  manifest: Manifest,
  candidate: { name: string | null; intent?: string | null },
): Manifest {
  const seed: Partial<Record<SoftFieldKey, string>> = {};
  const name = candidate.name?.trim();
  const intent = candidate.intent?.trim();
  if (!hasValue(manifest, 'name') && name) seed.name = name;
  if (!hasValue(manifest, 'tagline') && intent) seed.tagline = intent;
  return Object.keys(seed).length > 0 ? applySoftFields(manifest, seed) : manifest;
}

function softGenerated(manifest: Manifest): Partial<Record<SoftFieldKey, string | string[]>> {
  const out: Partial<Record<SoftFieldKey, string | string[]>> = {};
  for (const f of SOFT_FIELD_KEYS) {
    if (hasValue(manifest, f)) out[f] = manifest[f];
  }
  return out;
}

function createCapabilityErrorBody(err: unknown, traceId: string): ErrorBody {
  if (err instanceof CreateCapabilityError) {
    if (err.code === ErrorCode.NOT_FOUND) {
      return buildError(ErrorCode.NOT_FOUND, traceId, {
        userMessage: '没找到这条候选，可能已被删除，回上一步换一条。',
        action: 'change_input',
      }).error;
    }
    if (err.code === ErrorCode.FORBIDDEN) {
      return buildError(ErrorCode.FORBIDDEN, traceId, {
        userMessage: '你没有权限整理这条候选。',
        action: 'escalate',
      }).error;
    }
  }
  return buildError(ErrorCode.INTERNAL, traceId, {
    userMessage: '这一项没整理出来，稍后单独重试一下。',
    action: 'retry',
  }).error;
}

function noEvidenceBody(traceId: string): ErrorBody {
  return buildError(ErrorCode.STRUCTURE_NO_EVIDENCE, traceId, {
    userMessage: '这条会话内容不足，没法整理成能力，回上一步补点内容或换一条。',
    action: 'change_input',
  }).error;
}

function structureFieldFailedBody(traceId: string, field: SoftFieldKey): ErrorBody {
  return buildError(ErrorCode.PUBLISH_MISSING_FIELDS, traceId, {
    userMessage: '这一项还差几个字段没整理出来，去补齐后再发布。',
    action: 'change_input',
    details: { missingFields: [field] },
  }).error;
}

function notFoundBody(traceId: string): ErrorBody {
  return buildError(ErrorCode.NOT_FOUND, traceId, {
    userMessage: '没找到对应版本，可能已被删除。',
    action: 'change_input',
  }).error;
}
