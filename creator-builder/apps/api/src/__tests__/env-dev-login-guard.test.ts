// env.ts dev-login 守卫自检（安全第一，反向破坏可测）：
//   - 生产模式即便显式 DEV_LOGIN_ENABLED=true，loadEnv 也强制关回 false（绝不让种子登录上生产）；
//   - dev/test 模式 DEV_LOGIN_ENABLED=true 如实保留；DEV_SESSION_SECRET 原样透传。
// 每例用 vi.resetModules() 拿到全新模块级缓存（loadEnv 内部缓存 cached），并隔离 process.env。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SNAPSHOT = { ...process.env };

beforeEach(() => {
  vi.resetModules(); // 清模块缓存 → loadEnv 的 cached 重置
});

afterEach(() => {
  // 还原 process.env，避免跨例串台。
  for (const k of Object.keys(process.env)) {
    if (!(k in SNAPSHOT)) delete process.env[k];
  }
  Object.assign(process.env, SNAPSHOT);
});

/** 生产模式必须的密钥（避免 loadEnv 因缺密钥提前 throw，聚焦 dev-login 守卫本身）。 */
function setProductionRequiredEnv(): void {
  process.env.NODE_ENV = 'production';
  process.env.PROCESS = 'api';
  process.env.DATABASE_URL = 'postgres://u:p@db:5432/x';
  process.env.REDIS_QUEUE_URL = 'redis://r:6379/0';
  process.env.REDIS_HOT_URL = 'redis://r:6380/0';
  process.env.S3_ENDPOINT = 'http://s3:9000';
  process.env.S3_ACCESS_KEY = 'k';
  process.env.S3_SECRET_KEY = 's';
  process.env.LOGTO_ENDPOINT = 'http://logto:3001';
  process.env.LOGTO_ISSUER = 'http://logto:3001/oidc';
  process.env.LOGTO_JWKS_URI = 'http://logto:3001/oidc/jwks';
  process.env.LOGTO_APP_ID = 'app';
  process.env.LOGTO_APP_SECRET = 'secret';
  process.env.LOGTO_REDIRECT_URI = 'http://x/api/v1/auth/callback';
  process.env.LOGTO_AUDIENCE = 'aud';
}

describe('env dev-login 守卫', () => {
  it('生产：DEV_LOGIN_ENABLED=true 被强制关回 false（绝不上生产）', async () => {
    setProductionRequiredEnv();
    process.env.DEV_LOGIN_ENABLED = 'true'; // 误配
    process.env.DEV_SESSION_SECRET = 'leaked-secret';
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv();
    // 守卫核心：生产强制关闭（反向破坏——去掉 env.ts 那段 if，本断言转红）。
    expect(env.DEV_LOGIN_ENABLED).toBe(false);
  });

  it('dev：DEV_LOGIN_ENABLED=true 如实保留 + 密钥透传', async () => {
    process.env.NODE_ENV = 'development';
    process.env.PROCESS = 'api';
    process.env.DEV_LOGIN_ENABLED = 'true';
    process.env.DEV_SESSION_SECRET = 'dev-secret';
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv();
    expect(env.DEV_LOGIN_ENABLED).toBe(true);
    expect(env.DEV_SESSION_SECRET).toBe('dev-secret');
  });

  it('缺省：DEV_LOGIN_ENABLED 默认 false（未配即关）', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DEV_LOGIN_ENABLED;
    delete process.env.DEV_SESSION_SECRET;
    const { loadEnv } = await import('../config/env.js');
    const env = loadEnv();
    expect(env.DEV_LOGIN_ENABLED).toBe(false);
    expect(env.DEV_SESSION_SECRET).toBe('');
  });
});
