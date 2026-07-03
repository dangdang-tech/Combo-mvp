import {
  IdempotencyScope,
  type CreateCapabilityResult,
  type PublicCapabilityView,
  type RuntimeSessionMeta,
  type StartStructureResult,
} from '@cb/shared';
import { apiPost } from '../../../api/index.js';

export interface CreateTrialSessionResult {
  session: RuntimeSessionMeta;
  capability: PublicCapabilityView;
}

let openTrialUrl = (url: string): void => window.location.assign(url);

export function openRuntimeTrial(url: string): void {
  openTrialUrl(url);
}

export function __setOpenRuntimeTrialForTests(fn: (url: string) => void): () => void {
  const previous = openTrialUrl;
  openTrialUrl = fn;
  return () => {
    openTrialUrl = previous;
  };
}

export function createCapabilityForTrial(candidateId: string): Promise<CreateCapabilityResult> {
  return apiPost<CreateCapabilityResult>(
    '/capabilities',
    { sourceCandidateId: candidateId },
    {
      scope: IdempotencyScope.CAPABILITY_CREATE,
      idempotencyKey: `trial:create:${candidateId}`,
    },
  );
}

export function startStructureForTrial(versionId: string): Promise<StartStructureResult> {
  return apiPost<StartStructureResult>(
    `/versions/${encodeURIComponent(versionId)}/structure`,
    {},
    {
      scope: IdempotencyScope.STRUCTURE_START,
      idempotencyKey: `trial:structure:${versionId}`,
    },
  );
}

export async function createRuntimeTrialSession(input: {
  capabilityId: string;
  versionId: string;
  title: string;
}): Promise<CreateTrialSessionResult> {
  let res: Response;
  try {
    res = await fetch(
      `/api/v1/runtime/trial-chains/${encodeURIComponent(input.capabilityId)}/sessions`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: input.versionId, title: input.title }),
      },
    );
  } catch {
    throw new Error('网络好像不太稳，检查连接后重试。');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const userMessage =
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error?: { userMessage?: unknown } }).error?.userMessage === 'string'
        ? (body as { error: { userMessage: string } }).error.userMessage
        : '没能打开试用，请稍后重试。';
    throw new Error(userMessage);
  }

  return body as CreateTrialSessionResult;
}
