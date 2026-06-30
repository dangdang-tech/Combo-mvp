# apps/runtime（试用链路，占位）

类似 Chat Agent 的独立应用：用户在此运行已发布的能力包。当前仅占位，未写实现。

## 与 authoring 的边界（见飞书《Agora 创作者中心 · 后端仓库结构规范》）

- 只依赖 `@cb/shared`（含 `domains/skill-package.ts` 契约缝）与 `platform/` 机制。
- 禁止 import `apps/authoring/**` 的任何代码；两个应用只在能力包契约 + `capability.published` 事件流相遇。
- 真正落地时：补 `package.json`（@cb/runtime）+ `tsconfig.json`，把 `platform/` 升格为 `packages/platform` 供两个应用共享；运行时进程用独立最小权限凭据（只读已发布投影）。

## 预期结构

- `src/modules/`：conversation / agent / tools / session（消费 `SkillPackageRuntimeView`）。
- `src/processes/`：api（流式对话）+ worker（如需）。

> 占位说明：本目录暂无 `package.json`，故不参与 pnpm workspace 构建；开始实现时再转正。
