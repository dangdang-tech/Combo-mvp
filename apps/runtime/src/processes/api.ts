// api 进程：HTTP + SSE 服务端（试用端唯一进程）。
import { buildApp } from '../bootstrap/app.js';
import { loadEnv } from '../platform/config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`[runtime-api] listening on http://${env.HOST}:${env.PORT}`);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.log.info(`[runtime-api] ${sig} received, closing`);
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[runtime-api] fatal', err);
  process.exit(1);
});
