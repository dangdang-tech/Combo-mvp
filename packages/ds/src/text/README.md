# text 目录

本目录实现设计系统的文字排版组件，对外导出 `Text` 与 `Heading` 两个函数组件。

`Text` 负责正文层级的文字。它接受三个 prop：`variant` 在 `body`、`muted`、`caption`、`label` 四个字符串枚举里选一个，默认是 `body`；`as` 决定渲染成 `p`、`span` 还是 `div` 标签，默认是 `p`；`children` 是文字内容。`body` 用前景色正文字号，`muted` 换成弱化色，`caption` 在弱化色基础上再小一档字号，`label` 使用等宽字体、最小档字号并略微拉开字距，是否全大写由使用方自行决定，组件不做强制转换。

`Heading` 负责标题。它接受 `level`（取值 1 到 4 的数字枚举）与 `children`，渲染对应的 `h1` 到 `h4` 标签，使用衬线字体，字号沿 token 阶梯逐级递减，外边距已经归零，标题之间的间距由使用方排版。

两个组件的全部视觉状态都可以用纯 JSON props 表达，不需要传入任何函数。

## 文件说明

- `text.tsx`：`Text` 与 `Heading` 组件实现，以及 `TextProps`、`TextVariant`、`TextAs`、`HeadingProps`、`HeadingLevel` 类型导出。
- `text.css`：两个组件的样式，类名前缀分别是 `cb-text` 与 `cb-heading`，颜色、字号、字体全部引用 `--cb-*` 语义 token。
- `text.stories.tsx`：story 用例集合，覆盖默认正文、四种变体对照、标题阶梯、窄容器超长文本换行以及卡片摘要的真实组合。
- `text.test.tsx`：单元测试，断言纯 JSON props 可渲染、默认值正确、variant 与 as 映射到正确的 class 和标签、四级标题渲染对应的 heading 元素。
