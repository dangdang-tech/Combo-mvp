# @cb/ds — Combo 设计系统组件包

本包是 Combo 的 React 组件库，所有组件样式只引用 `@cb/ds-tokens` 输出的 `--cb-*` 语义 token，不出现裸 hex 颜色与魔法 px 数值（结构性 1px 描边宽度除外）。组件面向 React 18 函数组件编写，变体一律用字符串联合枚举 prop，全部视觉状态可以用不含函数的纯 JSON props 表达，回调 prop 只是可选的行为增强。业务应用从 `@cb/ds` 导入组件，从 `@cb/ds/styles.css` 导入样式。

## 目录职责

- `src/index.ts` 是唯一的 barrel，也是导出合同：每个组件目录负责实现这里列出的导出，新增组件必须先在这里加导出行，再建目录实现。
- `src/<组件名>/` 是各组件目录，当前共 16 个（avatar、badge、button、card、chat、citation、dialog、empty-state、input、list-item、markdown、mini-app-shell、skeleton、text、timestamp、toast），合计对外导出 20 个组件以及若干纯函数与类型。每个目录内有一份中文 README.md 说明该组件的职责与文件构成。
- `src/story-types.ts` 定义轻量 story 合同的类型（StoryGroup 等），各组件的 stories 文件按这份合同导出 `group` 对象。
- `src/css.d.ts` 为 CSS 导入提供模块声明，`src/test-setup.ts` 是 vitest 的测试环境准备（jest-dom 断言扩展）。
- `scripts/build-css.mjs` 在构建时把 src 下所有组件 CSS 按路径字典序汇总成 `dist/styles.css`；字典序保证产物幂等，组件样式之间不允许有顺序依赖。
- `vitest.config.ts` 是测试配置（jsdom 环境）。
- `dist/` 是构建产物目录，由 `tsc -b` 与 `build-css.mjs` 生成，禁止手改。

## 四件套约定

每个组件目录固定包含四件套加一份 README：`<组件名>.tsx` 是组件实现；`<组件名>.css` 是组件样式，只引用 `--cb-*` 语义 token，类名前缀 `cb-` 且全部 kebab-case；`<组件名>.stories.tsx` 按 `src/story-types.ts` 的合同导出 `group`，覆盖默认态、边界态与真实组合用例；`<组件名>.test.tsx` 用 @testing-library/react 断言纯 JSON props（不含任何函数）能渲染出正确内容，回调行为单独测试。README.md 用中文完整句子写明目录职责与每个文件干什么。

## demo 怎么跑

package.json 里配有 `demo` 脚本（`vite demo`，以包内 `demo/` 目录作为 vite 根），执行方式是在仓库根运行 `npx -y pnpm@11.0.9 -F @cb/ds demo`。当前仓库中 `demo/` 目录尚未创建，该脚本在目录补齐后可用。

## registry.json 与 llms.txt 是什么

`registry.json` 是按 shadcn registry 规范（`https://ui.shadcn.com/schema/registry.json`）编写的组件注册表，登记了每个组件的名称、标题、一句话使用场景、文件相对路径与外部依赖，供 registry 工具链和 agent 按条目机读组件清单。`llms.txt` 是给 AI agent 的文档索引：每行一条「组件名: README 路径 — 一句话何时用」，并列出 token 清单、经验体 UI schema、导出合同与仓库根 AGENTS.md 的路径。两份文件都以 `src/` 下实际目录为准维护，新增或调整组件时需要同步更新。

## 常用命令

在仓库根执行：构建用 `npx -y pnpm@11.0.9 -F @cb/ds build`，测试用 `npx -y pnpm@11.0.9 -F @cb/ds test`，lint 用根命令 `npx -y pnpm@11.0.9 lint`。设计系统的完整 agent 规则（样式禁令、组件规则、经验体 UI 规则、验证命令）见仓库根的 AGENTS.md。
