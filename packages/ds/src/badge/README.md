# badge 目录

本目录实现设计系统的徽标组件 Badge，负责用小面积的软色底标注状态或类别，常见位置是列表行、卡片标题旁和详情页字段旁。组件通过 `packages/ds/src/index.ts` 对外导出。

## 文件说明

- `badge.tsx` 实现 `Badge` 函数组件。变体走字符串联合枚举 `variant`（`neutral`、`ok`、`warn`、`danger`、`accent`，默认 `neutral`），除 children 外没有其他 props，所有视觉状态都能用纯 JSON props 表达。
- `badge.css` 定义 `cb-badge` 及五个变体的样式。每个变体使用对应的软色背景 token（例如 `--cb-ok-soft`）搭配同语义的前景色 token（例如 `--cb-ok`），字体使用等宽的 `--cb-font-mono` 小字号，圆角使用 `--cb-radius-pill` 形成胶囊形状，超长内容单行省略。
- `badge.stories.tsx` 按照 `story-types.ts` 的轻量合同导出 `group`，包含默认态、全部语义色、超长文本边界、列表行状态标注组合四个用例。
- `badge.test.tsx` 用 @testing-library/react 断言纯 JSON props 能渲染出正确文本与变体类名，并覆盖默认变体、五种变体枚举和超长文本。
