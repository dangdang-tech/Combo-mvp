// local Task HTTP 竖切：创建、Claim、设备签名进度、最终 CapabilityDefinition、幂等回放与发布前存储。
import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PIPELINE_SUBTASKS } from '@cb/shared';
import type { InfraContext } from '../platform/infra/index.js';
import {
  claimLocalExecutionHandler,
  createLocalTaskHandler,
  reportLocalProgressHandler,
  requireLocalExecutionAuth,
  submitLocalResultHandler,
} from '../modules/task/local-execution.js';
import { CAPABILITY_BUCKET } from '../modules/capability/persist.js';
import { FakeDb, FakeObjectStore, FakeStream } from './fakes.js';

const OWNER = 'user-local';
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function thumbprint(publicJwk: JsonWebKey): string {
  return sha256Base64Url(
    JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x }),
  );
}

function signedHeaders(
  privateKey: KeyObject,
  publicJwk: JsonWebKey,
  token: string,
  pathname: string,
  body: string,
): Record<string, string> {
  const timestamp = new Date().toISOString();
  const proof = ['POST', pathname, timestamp, sha256Base64Url(body)].join('\n');
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-combo-device-key': thumbprint(publicJwk),
    'x-combo-device-timestamp': timestamp,
    'x-combo-device-signature': signPayload(null, Buffer.from(proof), privateKey).toString(
      'base64url',
    ),
  };
}

async function testApp(): Promise<{
  app: FastifyInstance;
  db: FakeDb;
  objectStore: FakeObjectStore;
  stream: FakeStream;
}> {
  const app = Fastify({ logger: false });
  const db = new FakeDb();
  const objectStore = new FakeObjectStore();
  const stream = new FakeStream();
  app.decorate('infra', {
    db,
    objectStore,
    taskEvents: stream,
  } as unknown as InfraContext);
  app.post('/api/v1/tasks/local', {
    preHandler: async (request) => {
      request.auth = { userId: OWNER, account: 'local-user', roles: ['creator'] };
    },
    handler: createLocalTaskHandler(),
  });
  app.post('/api/v1/tasks/:taskId/local-execution/claim', claimLocalExecutionHandler());
  app.post('/api/v1/tasks/:taskId/local-progress', {
    preHandler: requireLocalExecutionAuth(),
    handler: reportLocalProgressHandler(),
  });
  app.post('/api/v1/tasks/:taskId/local-result', {
    preHandler: requireLocalExecutionAuth(),
    handler: submitLocalResultHandler(),
  });
  await app.ready();
  apps.push(app);
  return { app, db, objectStore, stream };
}

function localProgress(percent: number) {
  return {
    percent,
    phrase: percent === 80 ? '本地提取完成：1 个能力项' : '正在本地归纳提炼能力',
    subtasks: PIPELINE_SUBTASKS.map((subtask) => ({
      key: subtask.key,
      label: subtask.label,
      status:
        subtask.key === 'persist'
          ? ('pending' as const)
          : percent === 80
            ? ('done' as const)
            : subtask.key === 'extract'
              ? ('running' as const)
              : ('done' as const),
    })),
  };
}

const DEFINITION = {
  version: 1 as const,
  name: '本地研究助手',
  summary: '在本地归纳研究资料。',
  kind: 'research',
  instructions: '先核对资料，再形成结论。',
  inputs: [],
  starterPrompts: ['请研究这个主题'],
  meta: { fixture: true },
};

describe('local execution HTTP vertical slice', () => {
  it('reuses tasks, progress, capability object/index and result idempotency', async () => {
    const { app, db, objectStore, stream } = await testApp();
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/local',
      payload: { idempotencyKey: 'local-http-0001', description: '本地提取' },
    });
    expect(createdResponse.statusCode).toBe(201);
    expect(createdResponse.headers['cache-control']).toBe('no-store');
    const created = createdResponse.json().data as {
      task: { id: string; executionMode: string; currentStep: string };
      localExecution: { bindCode: string };
    };
    expect(created.task).toMatchObject({ executionMode: 'local', currentStep: 'extract' });
    expect(db.uploads.has(created.task.id)).toBe(false);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicJwk = publicKey.export({ format: 'jwk' });
    const privateKeyClaim = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${created.task.id}/local-execution/claim`,
      payload: {
        bindCode: created.localExecution.bindCode,
        devicePublicKey: privateKey.export({ format: 'jwk' }),
        workerVersion: 'local-worker/0.1.0',
        algorithmVersion: 'extract/test-v1',
      },
    });
    expect(privateKeyClaim.statusCode).toBe(400);

    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${created.task.id}/local-execution/claim`,
      payload: {
        bindCode: created.localExecution.bindCode,
        devicePublicKey: publicJwk,
        workerVersion: 'local-worker/0.1.0',
        algorithmVersion: 'extract/test-v1',
      },
    });
    expect(claimResponse.statusCode).toBe(200);
    expect(claimResponse.headers['cache-control']).toBe('no-store');
    const claim = claimResponse.json().data as { taskToken: string; nextExpectedSeq: number };
    expect(claim.nextExpectedSeq).toBe(1);
    let activeTaskToken = claim.taskToken;

    const progressPath = `/api/v1/tasks/${created.task.id}/local-progress`;
    const progressBody = JSON.stringify({ seq: 1, progress: localProgress(80) });
    const progressResponse = await app.inject({
      method: 'POST',
      url: progressPath,
      headers: signedHeaders(privateKey, publicJwk, activeTaskToken, progressPath, progressBody),
      payload: progressBody,
    });
    expect(progressResponse.statusCode).toBe(200);
    expect(db.tasks.get(created.task.id)?.meta.progress).toMatchObject({ percent: 80 });

    const wrongKey = generateKeyPairSync('ed25519');
    const rejectedProgress = await app.inject({
      method: 'POST',
      url: progressPath,
      headers: signedHeaders(
        wrongKey.privateKey,
        wrongKey.publicKey.export({ format: 'jwk' }),
        activeTaskToken,
        progressPath,
        progressBody,
      ),
      payload: progressBody,
    });
    expect(rejectedProgress.statusCode).toBe(401);

    const differentDeviceClaim = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${created.task.id}/local-execution/claim`,
      payload: {
        bindCode: created.localExecution.bindCode,
        devicePublicKey: wrongKey.publicKey.export({ format: 'jwk' }),
        workerVersion: 'local-worker/0.1.0',
        algorithmVersion: 'extract/test-v1',
      },
    });
    expect(differentDeviceClaim.statusCode).toBe(403);

    const reclaimResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${created.task.id}/local-execution/claim`,
      payload: {
        bindCode: created.localExecution.bindCode,
        devicePublicKey: publicJwk,
        workerVersion: 'local-worker/0.1.0',
        algorithmVersion: 'extract/test-v1',
      },
    });
    expect(reclaimResponse.statusCode).toBe(200);
    const reclaimed = reclaimResponse.json().data as {
      taskToken: string;
      nextExpectedSeq: number;
    };
    expect(reclaimed.nextExpectedSeq).toBe(2);
    expect(reclaimed.taskToken).not.toBe(activeTaskToken);
    expect(db.localExecutions.get(created.task.id)?.token_version).toBe(2);

    const revokedTokenResponse = await app.inject({
      method: 'POST',
      url: progressPath,
      headers: signedHeaders(privateKey, publicJwk, activeTaskToken, progressPath, progressBody),
      payload: progressBody,
    });
    expect(revokedTokenResponse.statusCode).toBe(401);
    activeTaskToken = reclaimed.taskToken;

    const resultPath = `/api/v1/tasks/${created.task.id}/local-result`;
    const resultBody = JSON.stringify({
      resultVersion: 1,
      workerVersion: 'local-worker/0.1.0',
      algorithmVersion: 'extract/test-v1',
      items: [DEFINITION],
    });
    const resultResponse = await app.inject({
      method: 'POST',
      url: resultPath,
      headers: signedHeaders(privateKey, publicJwk, activeTaskToken, resultPath, resultBody),
      payload: resultBody,
    });
    expect(resultResponse.statusCode).toBe(200);
    const result = resultResponse.json().data as {
      status: string;
      items: Array<{ id: string; published: boolean }>;
    };
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.published).toBe(false);
    expect(db.tasks.get(created.task.id)).toMatchObject({ status: 'succeeded' });
    expect(db.localExecutions.get(created.task.id)).toMatchObject({ result_status: 'committed' });
    expect(db.tasks.get(created.task.id)?.meta.progress).toMatchObject({ percent: 100 });

    const capabilityId = result.items[0]!.id;
    const definition = JSON.parse(
      await objectStore.getObjectText(
        CAPABILITY_BUCKET,
        `capabilities/${capabilityId}/definition.json`,
      ),
    );
    expect(definition).toEqual(DEFINITION);
    expect(stream.events(created.task.id)).toEqual(
      expect.arrayContaining(['state_snapshot', 'item-appended', 'done']),
    );

    const replayResponse = await app.inject({
      method: 'POST',
      url: resultPath,
      headers: signedHeaders(privateKey, publicJwk, activeTaskToken, resultPath, resultBody),
      payload: resultBody,
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data.items[0].id).toBe(capabilityId);
    expect(db.capabilities.size).toBe(1);

    const changedVersionBody = JSON.stringify({
      resultVersion: 1,
      workerVersion: 'local-worker/0.1.0',
      algorithmVersion: 'extract/test-v2',
      items: [DEFINITION],
    });
    const changedVersionResponse = await app.inject({
      method: 'POST',
      url: resultPath,
      headers: signedHeaders(
        privateKey,
        publicJwk,
        activeTaskToken,
        resultPath,
        changedVersionBody,
      ),
      payload: changedVersionBody,
    });
    expect(changedVersionResponse.statusCode).toBe(409);
  });
});
