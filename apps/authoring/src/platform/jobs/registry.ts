// JobHandler 注册表（B-10）。各 STEP 的具体 handler 在 3B-3E 注册（import/extract/structure/publish_batch）。
//   runner 据 jobType 取 handler 执行。本期可空（执行框架就绪、handler 由后续模块填）。
import type { JobType } from '@cb/shared';
import { ACTIVE_JOB_TYPES } from '@cb/shared';
import type { JobHandler } from './types.js';

const registry = new Map<JobType, JobHandler>();

/** 注册一个 STEP handler（重复注册同类型 = 覆盖，便于测试替换）。 */
export function registerHandler(handler: JobHandler): void {
  registry.set(handler.type, handler);
}

/** 取某类型 handler（未注册 → undefined，worker 据此跳过/告警，不裸崩）。 */
export function getHandler(jobType: JobType): JobHandler | undefined {
  return registry.get(jobType);
}

/** 已注册的类型清单（worker 启动据此建 BullMQ Worker；只对已注册类型起消费）。 */
export function registeredTypes(): JobType[] {
  return [...registry.keys()];
}

/** 本期应注册 processor 的四类（脊柱 §6.3）；worker 启动核对缺失（缺失只 warn 不崩，诚实标推迟）。 */
export function missingActiveHandlers(): JobType[] {
  const have = new Set(registry.keys());
  return (ACTIVE_JOB_TYPES as readonly JobType[]).filter((t) => !have.has(t));
}

/** 测试用：清空注册表。 */
export function _resetRegistry(): void {
  registry.clear();
}
