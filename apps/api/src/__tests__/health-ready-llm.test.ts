// /ready 的 llm 探针自检（P1-2：probeLlm 必须拿到 env，否则恒 degraded）。
//   脊柱 §10.2：llm required:false——degraded 不计 fatal，不影响 ready=true。
//   修法前 health.ts 调 probeLlm() 不传 env → 即便配了 key 也恒 llm=degraded（观测失真）。
//   修法后调 probeLlm(infra.env) → 配了 key 时 llm=ok；无 key 时 degraded 且不拖垮整体 ready。
// 反向破坏：把 health.ts 改回 probeLlm()（不传 env）→ 「有 key → llm=ok」这条转红（恒 degraded）。
//
// 测法：建最小 Fastify，decorate 一个 fake infra（仅 env + 假 redis 客户端），注册 health 路由后 inject /ready。
//   五个 required 探针在无真实依赖下会失败（ready=false / 503），但我们只断言 llm 这一项的 status，
//   并验证 llm=degraded 不会把 ready 拖成 false（用「llm degraded 但 db ok」无法纯单测构造，故另证
//   degraded 不进 anyRequiredDown）。
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { registerHealthRoutes } from '../routes/health.js';

/** 假 redis：ping 直接 reject（探针内 catch → false，不影响本测对 llm 的断言）。 */
const fakeRedis = { ping: () => Promise.reject(new Error('no redis')) } as unknown as Redis;

/** 造一个最小 env（仅 LLM 相关字段对 probeLlm 有意义；其余探针在无真实依赖下自然 false）。 */
function makeEnv(over: Partial<Env>): Env {
  return {
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    LLM_BASE_URL: 'https://openrouter.ai/api/v1',
    LLM_MODEL: '',
    // 让 db/minio/logto 探针指向不可达地址，确保它们 down（不连真实本机服务）。
    DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    LOGTO_JWKS_URI: 'http://127.0.0.1:1/jwks',
    ...over,
  } as unknown as Env;
}

/** 建最小 app：decorate fake infra（env + 假 redis），注册 health 路由。 */
async function buildHealthApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('infra', {
    env,
    redisQueue: fakeRedis,
    redisHot: fakeRedis,
  } as never);
  await registerHealthRoutes(app);
  await app.ready();
  return app;
}

type ReadyBody = {
  data: {
    ready: boolean;
    status: string;
    dependencies: Array<{ name: string; status: string; required: boolean }>;
  };
};

function llmDep(body: ReadyBody) {
  return body.data.dependencies.find((d) => d.name === 'llm')!;
}

describe('/ready llm 探针（P1-2：probeLlm 拿到 env）', () => {
  it('配了 OPENROUTER_API_KEY → llm dependency = "ok"（修法前恒 degraded）', async () => {
    const app = await buildHealthApp(makeEnv({ OPENROUTER_API_KEY: 'sk-or-xxx' }));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const body = res.json() as ReadyBody;
    const llm = llmDep(body);
    expect(llm.status).toBe('ok'); // ← 反向破坏（probeLlm 不传 env）此处转红
    expect(llm.required).toBe(false);
    await app.close();
  });

  it('配了 ANTHROPIC_API_KEY → llm dependency = "ok"', async () => {
    const app = await buildHealthApp(makeEnv({ ANTHROPIC_API_KEY: 'sk-ant-xxx' }));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const body = res.json() as ReadyBody;
    expect(llmDep(body).status).toBe('ok');
    await app.close();
  });

  it('无任何 LLM key → llm dependency = "degraded"（不阻塞、required:false）', async () => {
    const app = await buildHealthApp(makeEnv({}));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const body = res.json() as ReadyBody;
    const llm = llmDep(body);
    expect(llm.status).toBe('degraded');
    expect(llm.required).toBe(false);
    await app.close();
  });

  it('llm degraded 不计 fatal：degraded 不出现在「anyRequiredDown」判定里（required:false）', async () => {
    // 直接断言 llm 永远 required:false——即便它 degraded，readiness 的失败判定只看 required:true 的依赖。
    const app = await buildHealthApp(makeEnv({}));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const body = res.json() as ReadyBody;
    const requiredDown = body.data.dependencies.filter((d) => d.required && d.status === 'down');
    const llm = llmDep(body);
    expect(llm.required).toBe(false);
    // ready 仅由 required:true 的依赖决定；llm（degraded）不参与。
    expect(body.data.ready).toBe(requiredDown.length === 0);
    await app.close();
  });
});

// 直接对 probeLlm 单测（不经 HTTP），坐实「传 env vs 不传 env」的语义差（P1-2 根因）。
describe('probeLlm — 传 env 与否（P1-2 根因）', () => {
  it('不传 env → 恒 degraded（修法前 health 的错误用法语义）', async () => {
    const { probeLlm } = await import('../infra/llm/index.js');
    expect(probeLlm()).toBe('degraded');
  });

  it('传含 key 的 env → ok（修法后 health 的正确用法语义）', async () => {
    const { probeLlm } = await import('../infra/llm/index.js');
    expect(probeLlm(makeEnv({ OPENROUTER_API_KEY: 'sk-or-xxx' }))).toBe('ok');
  });
});
