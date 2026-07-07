# @cb/miniapp-renderer

本包是经验体 mini-app 的受限 UI 渲染器。runtime agent 产出一份符合白名单结构的 JSON 文档（顶层是 `{ version: 1, root: 节点 }`），本包先用 zod 校验这份文档，校验通过后把节点树递归映射为 @cb/ds 设计系统组件；校验失败则渲染一张降级错误卡片，整个过程不抛异常、不执行文档里的任何代码。

白名单共 12 种节点类型：stack、heading、text、markdown、card、list-item、badge、button、citation、empty-state、timestamp、skeleton。除结构校验外还有两条整体约束：节点嵌套深度不超过 6 层（根节点算第 1 层），节点总数不超过 200。button 节点只携带 actionId 字符串，点击时通过宿主传入的 onAction 回调上报，具体行为完全由宿主决定。

## 目录结构

- `src/` 存放 zod schema、渲染器组件与测试，详见该目录的 README。
- `schema/` 存放手写的 JSON Schema（draft-07），描述与 zod 相同的文档结构，供 runtime agent 当作输出格式约束使用。
- `examples/` 存放两份真实感的示例文档，测试会验证它们同时满足 zod 校验和 JSON Schema 的节点白名单。
- `package.json` 声明包入口（`dist/index.js`）、JSON Schema 的导出路径（`./schema/miniapp-ui.schema.json`）以及构建、测试脚本。
- `tsconfig.json` 继承仓库根的 tsconfig.base.json，通过 project reference 依赖 `../ds`，只编译 `src/` 下的非测试文件到 `dist/`。
- `vitest.config.ts` 配置 jsdom 环境与 React 插件，测试文件匹配 `src/**/*.test.{ts,tsx}`。

## 常用命令

在本目录执行 `pnpm test` 运行全部测试，执行 `pnpm build`（即 `tsc -b`）产出 `dist/`。构建前需要先构建依赖包 `@cb/ds`。
