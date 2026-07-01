// 上传向导的步骤实现模块（PRD 2 步：F-10 STEP① 上传 + 能力页）。在 WizardShell 的 <Outlet> 内渲染（外壳恒定 D14）。
//   能力页融合原「提取过程态」+「批量发布」为单页三态（提取中 → 候选卡 → 一键发布），复用 step2-extract /
//   step5-publish 的展示件与 SSE 接线（结构坍缩：不再有 提取/选择/结构化/发布 四个独立路由步）。
export { ImportStepPage } from './step1-import/index.js';
export { CapabilitiesStepPage } from './step2-capabilities/index.js';
