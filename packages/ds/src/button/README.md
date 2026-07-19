# button 目录

本目录实现设计系统的按钮组件 Button，负责页面上所有可点击操作的统一视觉形态。组件通过 `packages/ds/src/index.ts` 对外导出。

## 文件说明

- `button.tsx` 实现 `Button` 函数组件。变体走字符串联合枚举 `variant`（`primary`、`secondary`、`ghost`、`danger`，默认 `secondary`），尺寸走 `size`（`sm`、`md`、`lg`，默认 `md`）。`loading` 为真时在文字左侧渲染一个 border 动画 spinner，并把按钮置为禁用以阻止重复提交。所有视觉状态都能用纯 JSON props 表达，`onClick` 只是可选的行为增强。
- `button.css` 定义 `cb-btn` 及其变体、尺寸、spinner 的样式，颜色、间距、圆角、字体、动效全部引用 `--cb-*` 语义 token。primary 使用 `--cb-accent` 底配 `--cb-surface-raised` 前景，悬停与按压分别切到 `--cb-accent-strong` 与 `--cb-accent-pressed`；secondary 使用 `--cb-surface` 底加 `--cb-line-1` 描边；danger 使用 `--cb-danger`。键盘聚焦时用 `--cb-focus-ring` 画双层 ring。
- `button.stories.tsx` 按照 `story-types.ts` 的轻量合同导出 `group`，包含默认态、变体尺寸矩阵、加载与禁用、超长文本边界、对话框底部操作组合五个用例。
- `button.test.tsx` 用 @testing-library/react 断言纯 JSON props（不含任何函数）能渲染出正确内容和变体类名，并单独测试点击回调与禁用、加载态下回调不触发。
