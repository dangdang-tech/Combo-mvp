// JobHandler 注册入口（worker 副作用导入此模块即完成全部 handler 注册）。
//   import handler（B-19）：装配真实 infra（PG / S3 / tx pool）→ registerHandler。
//   extract handler（B-22/B-23）：装配 PG / tx pool / 3A LLM 网关 → registerHandler。
//   structure handler（B-25）：装配 PG / 3A LLM 网关 → registerHandler（直读证据流式生成软字段，受保护写 structure_state/manifest）。
// 与契约 §11.A 一致：handler 写库走仓储的受保护 fence CTE；db = 与 runner 同库的 pg.Pool。
import { loadEnv } from '../platform/config/env.js';
import { getPool } from '../platform/infra/db.js';
import { createS3ObjectStore } from '../platform/infra/object-store.js';
import { createLlmGateway } from '../platform/infra/llm/index.js';
import { asTxPool } from '../platform/events/db-tx.js';
import { registerHandler } from '../platform/jobs/registry.js';
import { createImportHandler } from '../modules/import/index.js';
import { createExtractHandler } from '../modules/extract/index.js';
import { createStructureHandler } from '../modules/structure/index.js';

/** 装配 + 注册 import handler（worker 启动期调用一次；幂等——重复注册覆盖）。 */
export function registerImportHandler(): void {
  const env = loadEnv();
  const db = getPool(env);
  registerHandler(
    createImportHandler({
      db,
      txPool: asTxPool(db),
      objectStore: createS3ObjectStore(env),
    }),
  );
}

/** 装配 + 注册 extract handler（B-22/B-23）。LLM 网关无 ANTHROPIC_API_KEY → degraded（命名用确定性兜底，不阻塞）。 */
export function registerExtractHandler(): void {
  const env = loadEnv();
  const db = getPool(env);
  registerHandler(
    createExtractHandler({
      db,
      txPool: asTxPool(db),
      gateway: createLlmGateway(env, db),
    }),
  );
}

/** 装配 + 注册 structure handler（B-25）。LLM 网关无 ANTHROPIC_API_KEY → degraded（软字段用确定性兜底，不裸转圈/不裸 502）。 */
export function registerStructureHandler(): void {
  const env = loadEnv();
  const db = getPool(env);
  registerHandler(
    createStructureHandler({
      db,
      gateway: createLlmGateway(env, db),
    }),
  );
}

// 副作用注册（worker 入口 `import './register-handlers.js'` 即触发）。
registerImportHandler();
registerExtractHandler();
registerStructureHandler();
