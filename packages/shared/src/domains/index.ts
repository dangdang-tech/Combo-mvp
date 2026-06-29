// 各域 DTO / zod schema（依据契约 10~70）。归 src/shared/，Phase 3/4 直接 import。
export * from './auth.js';
export * from './import.js';
export * from './redaction.js'; // B-17 去敏引擎（纯函数，import.ts 类型的生产者）
export * from './extract.js';
export * from './structure.js';
export * from './publish.js';
export * from './dashboard.js';
export * from './events.js';
