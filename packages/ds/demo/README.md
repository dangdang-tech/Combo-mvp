# demo 组件画廊

本目录是 @cb/ds 的组件画廊，用 Vite 把 src 下每个组件的 story 用例渲染成一个可以人工 review 的页面。画廊会自动收集所有 `*.stories.tsx` 文件里导出名为 `group` 的 StoryGroup 对象（合同定义在 `../src/story-types.ts`），不需要在本目录做任何注册。

## 使用方式

在 `packages/ds` 目录执行 `pnpm run demo` 可以启动开发服务器并在浏览器里查看画廊。执行 `pnpm exec vite build demo` 可以做一次纯构建检查，产物默认输出到本目录的 `dist/` 下。

## 页面功能

页面左侧是按组件标题排序的锚点目录，点击后跳转到对应组件的小节。右侧按组件分节展示，每个小节包含组件标题，以及该组件的全部 story：每个 story 是一张带描边的卡片，卡片头部显示 story 名称与一句话说明（note），卡片主体是 story 的实际渲染结果。顶部工具栏提供两个控件：一个 Light 与 Dark 主题切换按钮（通过写 `document.documentElement` 的 `data-cb-theme` 属性生效），一个「全部组件或单个组件」的筛选下拉框。

## 文件说明

- `index.html` 是页面的 HTML 入口，只包含挂载节点和对 `main.tsx` 的模块引用。
- `main.tsx` 是画廊应用本体。它先引入 `@cb/ds-tokens/tokens.css` 与本目录的 `demo.css`，再用 `import.meta.glob` 立即加载 `../src` 下所有 story 文件和所有组件样式文件（后者是副作用引入，保证组件外观完整），最后把收集到的 StoryGroup 按 title 排序渲染成整个画廊页面。
- `demo.css` 是画廊自身的布局与外观样式，所有取值只引用 `--cb-*` 语义 token，结构性描边统一为一像素并使用 token 颜色。
- `vite.config.ts` 是画廊的 Vite 配置。它把构建根目录固定为本目录，把开发服务器的文件访问范围放开到仓库根目录（这样才能读取 `../src` 源码与 workspace 链接的 `@cb/ds-tokens` 产物），并把构建缓存放在包级 `node_modules` 下。
- `tsconfig.json` 只服务于编辑器与手动类型检查（`tsc -p demo --noEmit`），它引入了 `vite/client` 类型让 `import.meta.glob` 可以通过类型检查；组件包自身的 `tsc -b` 构建不引用它。
