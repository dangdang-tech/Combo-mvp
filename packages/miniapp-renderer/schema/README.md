# schema 目录

本目录存放手写维护的 JSON Schema 文件，与 `src/schema.ts` 里的 zod schema 描述同一套 mini-app UI 文档结构。

- `miniapp-ui.schema.json` 是 draft-07 版本的 JSON Schema，顶层要求 `{ version: 1, root: 节点 }`，definitions 里逐一定义 12 种白名单节点（每种节点用 `type` 字段的 const 值判别），并且所有对象都声明 `additionalProperties: false`。它的用途是交给 runtime agent 当作输出格式约束，让 agent 在生成经验体 UI 时直接对着这份 schema 产出 JSON。

两条整体约束（嵌套深度不超过 6 层、节点总数不超过 200）无法用 draft-07 表达，写在了 schema 顶层的 description 里，实际由渲染器内的 zod 校验强制执行。修改 `src/schema.ts` 里的节点结构时必须同步修改本文件，`src/renderer.test.tsx` 中有一条测试会校验两边的节点类型白名单完全一致。
