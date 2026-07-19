# mini-app-shell 组件目录

本目录实现经验体（mini-app）的容器组件 `MiniAppShell`。它是一个 paper 底、hero 圆角（`--cb-radius-hero`）、hero 阴影（`--cb-shadow-hero`）的卡片外壳，分为头部、内容区和可选的底部三段。头部左侧是衬线字体标题和等宽字体的 muted 副标题，右侧依次是状态指示（小圆点加等宽状态词）和 actions 插槽；内容区用 `--cb-surface` 做底并带内衬 padding；footer 存在时与内容区之间有一条 `--cb-line-3` 分隔线。

状态是三值字符串枚举：`running` 用 `--cb-warn` 色并让圆点做缓慢呼吸动画（系统开启减动效时停用），`ok` 用 `--cb-ok` 色，`error` 用 `--cb-danger` 色。全部视觉状态都能用纯 JSON props 表达，`actions` 与 `footer` 插槽也接受纯字符串。

## 文件说明

- `mini-app-shell.tsx` 导出 `MiniAppShell` 组件、`MiniAppShellProps` 类型和 `MiniAppShellStatus` 状态枚举类型。副标题、状态、actions、footer 都是可选 prop，未传时对应节点不渲染。
- `mini-app-shell.css` 定义 `.cb-mini-app-shell` 及其子元素的全部样式，颜色、间距、圆角、阴影、字体、动效只引用 `--cb-*` 语义 token，呼吸动画周期由 `--cb-duration-slow` 推导。
- `mini-app-shell.stories.tsx` 导出 `group`（StoryGroup 对象），包含默认形态、超长标题加 error 态、running 中间态、组合 Markdown 正文与 actions 四个用例。
- `mini-app-shell.test.tsx` 覆盖纯 JSON props 渲染全部插槽、可选 prop 缺省时不渲染对应节点、三个状态枚举的类名与状态词，以及内容区和 footer 的落位。
