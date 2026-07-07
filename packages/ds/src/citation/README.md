# citation 组件目录

本目录实现设计系统的行内引用组件，对外提供一个导出：`Citation`。组件用等宽小字标注内容来源，props 为 `{ label, href?, quote?, index? }`，全部视觉状态用纯 JSON props 即可表达。提供 `index` 时会渲染一个 `[n]` 上标风格徽标，底色是 accent-soft、文字是 accent；提供 `href` 时 label 渲染为链接，下划线是 line-1 颜色的虚线，hover 时文字和下划线变为 accent；提供 `quote` 时在下方渲染一条带 line-3 左边框的引文块，文字为正常体的 muted 颜色。

目录中各文件的职责如下。`citation.tsx` 实现 `Citation` 组件与 `CitationProps` 类型。`citation.css` 是组件样式，颜色、间距、圆角和字体全部引用 `--cb-*` 语义 token，引文块左边框为结构性 1px 描边。`citation.stories.tsx` 按轻量 story 合同导出 `group`，包含默认态、无链接无序号的退化态、超长文本边界态和正文段落内多引用的真实组合用例。`citation.test.tsx` 用 @testing-library/react 断言纯 JSON props 可渲染出徽标、链接和引文块，并覆盖各可选 prop 缺省时的分支与 `index` 为 0 的边界。
