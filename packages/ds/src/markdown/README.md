# markdown 组件目录

本目录实现设计系统的 Markdown 渲染组件，负责把 Markdown 字符串安全地渲染成带 Combo 视觉样式的 HTML。渲染链路是先用 marked 做同步解析（显式传入 `async: false`），再用 DOMPurify 按 `USE_PROFILES: { html: true }` 消毒，只放行常规 HTML 标签，svg 与 mathml 标签、script 标签以及 onerror 之类的事件属性都会被剥除，最后通过 `dangerouslySetInnerHTML` 写入一个 `.cb-markdown` 容器。

## 文件说明

- `markdown.tsx` 导出 `Markdown` 组件与 `MarkdownProps` 类型。组件只接受一个 `content` 字符串 prop，解析与消毒的结果用 `useMemo` 按 `content` 缓存。
- `markdown.css` 定义 `.cb-markdown` 作用域内的全部排版样式：h1 到 h3 用衬线字体并按 mini-app 语境降两档字号（h1 用 `--cb-text-xl`、h2 用 `--cb-text-lg`、h3 用 `--cb-text-md`），行内代码用等宽字体加 `--cb-muted-bg` 底色，代码块用 `--cb-fg` 做底、`--cb-paper` 做字并支持横向滚动，链接用 `--cb-accent` 加下划线，引用块带 `--cb-line-1` 左边框且文字用 `--cb-muted`，表格用 `--cb-line-2` 做行分隔线。
- `markdown.stories.tsx` 导出 `group`（StoryGroup 对象），包含默认正文、空内容、注入与超长文本、经验体正文组合四个用例。
- `markdown.test.tsx` 覆盖纯 JSON props 渲染、script 标签被剥除、img 的 onerror 属性被剥除、svg 与 mathml 被剥除、常见 Markdown 结构（代码、链接、引用、表格）渲染以及空字符串输入。
