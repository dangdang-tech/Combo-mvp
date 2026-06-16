// JobHandler 注册入口（worker 副作用导入此模块即完成全部 handler 注册）。
//   import handler（B-19）：装配真实 infra（PG / S3 / tx pool）→ registerHandler。
//   extract handler（B-22/B-23）：装配 PG / tx pool / 3A LLM 网关 → registerHandler。
//   structure handler（B-25）：装配 PG / 3A LLM 网关 → registerHandler（直读证据流式生成软字段，受保护写 structure_state/manifest）。
//   publish_batch（3E）落位后在此追加注册行。
// 与契约 §11.A 一致：handler 写库走仓储的受保护 fence CTE；db = 与 runner 同库的 pg.Pool。
import { loadEnv } from '../../config/env.js';
import { getPool } from '../../infra/db.js';
import { createS3ObjectStore } from '../../infra/object-store.js';
import { createLlmGateway } from '../../infra/llm/index.js';
import { asTxPool } from '../../events/db-tx.js';
import { registerHandler } from '../registry.js';
import { createImportHandler } from './import.js';
import { createExtractHandler } from './extract.js';
import { createStructureHandler } from './structure.js';
import { createPublishBatchHandler } from './publish-batch.js';

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

/** 装配 + 注册 publish_batch handler（B-29 无连坐 P0）。逐项复用发布门事务（publish-one），失败只标该 item、不连坐其余。 */
export function registerPublishBatchHandler(): void {
  const env = loadEnv();
  const db = getPool(env);
  registerHandler(
    createPublishBatchHandler({
      db,
      txPool: asTxPool(db),
    }),
  );
}

// 副作用注册（worker 入口 `import '../jobs/handlers/index.js'` 即触发）。
registerImportHandler();
registerExtractHandler();
registerStructureHandler();
registerPublishBatchHandler();
