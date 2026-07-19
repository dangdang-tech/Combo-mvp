# chat 目录说明

本目录实现设计系统的会话相关组件，一个目录内提供三个导出：`Thread`、`Message`、`Composer`，全部从 `chat.tsx` 导出，供 `src/index.ts` 的包出口统一转发。

## 组件职责

`Thread` 是会话流的布局容器。它把消息按垂直方向排列，消息之间的间距使用间距 token，内容列在容器内水平居中，并按 `maxWidth` 属性限制最大宽度（`md` 与 `lg` 两档，宽度上限用 rem 单位表达，因为 token 清单中没有内容列宽度的 token）。

`Message` 是单条消息。`role` 属性决定样式：`user` 消息靠右，底色是柔和强调色，整体是卡片圆角但右上角是一个更小的圆角；`assistant` 消息靠左，表面色底加细描边；`system` 消息在内容列居中，是一条弱化颜色、等宽小字的窄条。`author` 与 `timestamp` 会显示在气泡上方的一行等宽小字里，时间戳按「时:分」格式化，解析失败时原样显示。`pending` 为 true 时，内容区渲染三个循环呼吸的圆点代替正文，动画时长与延迟由动效 token 推导。

`Composer` 是消息输入框。文本域高度随内容自动增长，一行起步、六行封顶，超过六行后在内部滚动；右侧是复用 `../button/button` 的发送按钮（primary 变体、sm 尺寸），`sending` 为 true 时按钮进入 loading 态。按 Enter 提交，Shift+Enter 换行；提交文本会先去除首尾空白，结果为空时不触发 `onSubmit`；提交成功后输入框清空。`onSubmit` 是可选的行为增强，不传时组件依然可以正常渲染与输入。容器是白纸浮起底、细描边、卡片圆角，获得焦点时描边颜色换成焦点色。

## 文件清单

`chat.tsx` 是组件实现，包含 `Thread`、`Message`、`Composer` 三个组件以及时间格式化的内部函数。

`chat.css` 是组件样式，所有颜色、间距、圆角、阴影、字体与动效都引用 `--cb-*` 语义 token，仅结构性描边使用 1px 字面量。

`chat.stories.tsx` 按轻量 story 合同导出 `group`，包含默认对话、生成中与系统提示、超长文本边界、输入框三种状态、完整会话组合五个用例。

`chat.test.tsx` 是组件测试，验证三个组件在纯 JSON props（不含任何函数）下能渲染出正确内容，并单独覆盖 `Composer` 的提交、清空、空文本拦截与 Shift+Enter 换行等回调行为。
