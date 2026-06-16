// JobHandler 注册入口（worker 副作用导入此模块即完成全部 handler 注册）。
//   import handler（B-19）：装配真实 infra（PG / S3 / tx pool）→ registerHandler。
//   extract handler（B-22/B-23）：装配 PG / tx pool / 3A LLM 网关 → registerHandler。
//   structure/publish_batch（3D-3E）落位后在此追加注册行。
// 与契约 §11.A 一致：handler 写库走仓储的受保护 fence CTE；db = 与 runner 同库的 pg.Pool。
import { loadEnv } from '../../config/env.js';
import { getPool } from '../../infra/db.js';
import { createS3ObjectStore } from '../../infra/object-store.js';
import { createLlmGateway } from '../../infra/llm/index.js';
import { asTxPool } from '../../events/db-tx.js';
import { registerHandler } from '../registry.js';
import { createImportHandler } from './import.js';
import { createExtractHandler } from './extract.js';

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

// 副作用注册（worker 入口 `import '../jobs/handlers/index.js'` 即触发）。
registerImportHandler();
registerExtractHandler();
