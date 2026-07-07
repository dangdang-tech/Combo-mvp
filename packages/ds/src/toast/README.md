# toast 组件目录

本目录实现设计系统的通知组件，对外提供三个导出：`Toast`、`ToastProvider` 和 `useToast`。`Toast` 是纯视觉的通知条，白底（surface-raised）配 overlay 阴影，左侧有一条 3px 宽的变体色条，变体取值为 `'info' | 'ok' | 'warn' | 'danger'`，全部视觉状态用纯 JSON props 即可表达。`ToastProvider` 在内部用 useState 维护通知队列，在页面右下角渲染一个 `aria-live="polite"` 的固定区域，每条通知到时自动消失（缺省 4000 毫秒，可用 `durationMs` 覆盖）。`useToast` 返回 `{ toast }` 方法用于入队通知，必须在 `ToastProvider` 内部调用，否则会抛出错误。

目录中各文件的职责如下。`toast.tsx` 实现上述三个导出以及 `ToastProps`、`ToastOptions`、`ToastVariant` 类型。`toast.css` 是组件样式，颜色、间距、圆角、阴影和字体全部引用 `--cb-*` 语义 token，其中左侧色条宽度按规格固定为 3px，通知区域宽度复用 `--cb-sidebar-w` token。`toast.stories.tsx` 按轻量 story 合同导出 `group`，包含默认态、四种变体一览、超长文本边界态和 Provider 触发的真实组合用例。`toast.test.tsx` 用 @testing-library/react 断言纯 JSON props 可渲染，并用假计时器验证队列的自动消失行为与 Provider 外调用 hook 抛错。
