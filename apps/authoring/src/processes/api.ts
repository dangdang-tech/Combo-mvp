// api 进程：HTTP + SSE 服务端（多进程拆分，技术方案 §文件树）。
import { loadEnv } from '../platform/config/env.js';
import { startNodeObservability } from '../platform/observability/node.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const observability = startNodeObservability(env, 'api');
  const { buildApp } = await import('../bootstrap/app.js');
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    { observability: observability.enabled },
    `[api] listening on http://${env.HOST}:${env.PORT}`,
  );

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.log.info(`[api] ${sig} received, closing`);
      void app
        .close()
        .then(() => observability.shutdown())
        .then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[api] fatal', err);
  process.exit(1);
});
