# dialog 目录

本目录实现设计系统的模态对话框组件 Dialog，基于 @radix-ui/react-dialog 封装，可访问性（焦点圈定、Esc 关闭、aria 关联）由 Radix 提供。组件是受控的：显示与否完全由 open 属性决定；onOpenChange 是可选的行为增强，不传时对话框依然按 open 的值正确渲染，因此不含任何函数的纯 JSON props 也能表达全部视觉状态。

## 文件说明

- `dialog.tsx` 是组件实现。导出 DialogProps 接口与 Dialog 函数组件；面板内固定渲染标题（Radix Title，衬线字体）与右上角 ghost 样式关闭钮，description、children、footer 三个区块按传入与否条件渲染；description 缺省时显式把 aria-describedby 置空以避免 Radix 的悬空引用告警。
- `dialog.css` 是组件样式。遮罩用 color-mix 从 --cb-fg 派生的墨色半透明；内容面板使用 --cb-surface-raised 白底、--cb-radius-card 圆角与 --cb-shadow-overlay 阴影，超高内容在面板内部滚动；进出场动画通过 Radix 的 data-state 属性驱动，时长与缓动分别引用 `--cb-duration-fast`、`--cb-duration-base` 与 `--cb-ease-standard`、`--cb-ease-decelerate` 动效 token。
- `dialog.stories.tsx` 导出符合 StoryGroup 合同的 story 集合，包含带完整区块的默认态、超长标题加超高正文且无描述的边界态，以及删除前二次确认的真实组合用例；每个 story 通过一个本地受控壳组件按钮触发打开。
- `dialog.test.tsx` 是组件测试。断言纯 JSON props（不含任何函数）在 open 为 true 时渲染出标题、描述、正文与底部操作区，open 为 false 时不渲染，另外覆盖区块缺省形态、点击关闭钮与按 Esc 时 onOpenChange 以 false 回调。
