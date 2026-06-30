// structure（结构化）域唯一对外出口（跨域只 import 本文件，不深入模块内部文件）。
//   被依赖方：routes/index.ts 注册路由、jobs/handlers/index.ts 注册 worker handler、
//             publish 域 batch-structure（合法下游→上游单向依赖）复用建能力体/结构化用例。
export { STRUCTURE_ENDPOINTS, registerStructureRoutes } from './routes.js';
export { createStructureHandler } from './job.js';

// publish 域「全部发布」编排复用的结构化用例（下游 → 上游，单向）。
export {
  createCapability,
  CreateCapabilityError,
  CreateCapabilityFencedError,
} from './create-capability.js';
export { readEvidenceForCandidate, writeManifestAndStateProtected } from './repo.js';
export { applySoftField, manifestToStructureState, isArrayField } from './manifest.js';
export { generateFieldWithRetry, type GenContext } from './generate.js';
