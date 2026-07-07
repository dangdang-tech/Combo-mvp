# empty-state 目录

本目录实现设计系统的空状态组件 EmptyState，用于列表、收件箱等区域没有内容时的居中占位展示。组件接收 title（必填字符串标题，衬线字体）、description（可选弱化描述）、icon（可选图标插槽）与 action（可选操作插槽）四个 props；icon 与 action 不传时对应区域完全不渲染。全部视觉状态可以只用纯 JSON props 表达，插槽是可选增强。

目录内各文件的职责如下。empty-state.tsx 是组件实现，定义 EmptyStateProps 接口并导出 EmptyState 函数组件。empty-state.css 是组件样式，只引用 --cb-\* 语义 token，根节点带极淡的网格纸背景（网格线颜色用 --cb-grid，格距用 --cb-space-5），标题使用 --cb-font-serif 衬线字体，描述使用 --cb-muted 弱化色。empty-state.stories.tsx 按仓库轻量 story 合同导出 group 对象，包含默认态、超长文本边界态、带图标与操作按钮的组合态三个用例。empty-state.test.tsx 用 @testing-library/react 断言纯 JSON props 可渲染、可选区域按需省略、插槽内容落在正确区域。
