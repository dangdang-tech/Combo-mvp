# src 目录

本目录是 @cb/miniapp-renderer 的源码，包含文档校验、渲染组件与测试。

- `schema.ts` 定义 mini-app UI 文档的 zod schema 与对应的 TypeScript 类型。`nodeSchema` 是以 type 字段判别的 12 种白名单节点联合（递归引用经 z.lazy 延迟求值），`miniAppDocumentSchema` 是顶层文档 schema，并用 superRefine 追加两条整体约束：嵌套深度不超过 `MAX_DEPTH`（6 层），节点总数不超过 `MAX_NODES`（200 个）。同时导出 `NODE_TYPES` 白名单常量，供测试与宿主做一致性检查。
- `renderer.tsx` 导出 `MiniAppRenderer` 组件。它接收 unknown 类型的 document，先经 `miniAppDocumentSchema.safeParse` 校验：失败时渲染由 @cb/ds 的 Card、Badge、Text 组成的降级错误卡片（列出前 5 条校验问题），成功时把节点树递归映射为 @cb/ds 组件。stack 节点不引入 CSS 文件，用内联 flex 样式实现，gap 取值引用 `var(--cb-space-*)` 间距 token。button 节点点击时把 actionId 传给可选的 onAction 回调。传入 title 时整体包在 @cb/ds 的 MiniAppShell 外壳里，并按校验结果显示 ok 或 error 状态。文件内不直接使用 dangerouslySetInnerHTML，markdown 节点走 @cb/ds 的 Markdown 组件（内部有 DOMPurify 消毒）。
- `index.ts` 是包的唯一出口，转发 schema.ts 与 renderer.tsx 的全部导出。
- `renderer.test.tsx` 是 vitest 测试：验证 examples 目录的示例同时通过 zod 校验和 JSON Schema 的 type 白名单、合法文档渲染出关键内容、12 种节点全部可渲染、垃圾对象与超深嵌套与超量节点与未知 type 都降级为错误卡片且不抛异常、button 点击回调收到 actionId、渲染器源码不含 dangerouslySetInnerHTML、markdown 里的 script 被消毒剥除。
- `test-setup.ts` 在测试启动时引入 @testing-library/jest-dom 的断言扩展。
