# input 目录

本目录实现设计系统的文本输入框组件 Input，支持 text、search、password 三种类型，提供 label 关联、校验失败态与禁用态。search 类型会在输入框左侧渲染一个用内联 SVG 画的放大镜图标，图标颜色跟随 currentColor。组件同时支持受控（value）与非受控（defaultValue）两种用法；只传 value 不传 onChange 时输入框按只读渲染，因此不含任何函数的纯 JSON props 也能渲染出正确内容。

## 文件说明

- `input.tsx` 是组件实现。导出 InputProps 接口与 Input 函数组件；label 存在时渲染 label 元素并通过 htmlFor 关联输入框，id 缺省时用 React 的 useId 自动生成；invalid 为 true 时在输入框上写 aria-invalid 属性，样式据此切换到危险色描边。
- `input.css` 是组件样式。所有颜色、间距、圆角、字体、动效都引用以 `--cb-` 为前缀的语义 token；正常聚焦使用 `--cb-focus-ring` 颜色的描边与焦点环，校验失败聚焦使用 `--cb-danger` 描边加 `--cb-danger-line` 焦点环；label 使用等宽字体 `--cb-font-mono`。
- `input.stories.tsx` 导出符合 StoryGroup 合同的 story 集合，覆盖默认态、搜索型、校验失败加超长文本的边界态、禁用态，以及登录表单的真实组合用例。
- `input.test.tsx` 是组件测试。断言纯 JSON props（不含任何函数）可以渲染出 label 关联、当前值与校验失败态，另外覆盖搜索图标渲染、自定义 id 关联、onChange 字符串回调与禁用态。
