# list-item

本目录实现设计系统的列表行组件 ListItem。它是会话列表、经验体列表等纵向列表里的单行，由行首插槽（leading）、主体（title 加可选 description）与行尾插槽（trailing）三段组成。`title` 是唯一必填 prop；`selected` 控制选中态；`onClick` 是可选的行为增强，提供时整行渲染为原生 `button`（因此天然键盘可达），不提供时渲染为 `div`，所有视觉状态（包括选中态）都可以用不含函数的纯 JSON props 表达。

## 文件说明

- `list-item.tsx` 导出 `ListItem` 组件与 `ListItemProps` 类型。根据是否传入 `onClick` 选择渲染 `button` 或 `div`，选中时会同时输出 `cb-list-item--selected` 类名与 `aria-current="true"` 属性。
- `list-item.css` 定义行的弹性布局、悬停底色（`--cb-muted-bg`）、选中底色（`--cb-accent-soft`）与左侧 `--cb-accent` 指示条、标题单行截断、描述 muted 小字两行截断，以及键盘聚焦时的 focus ring。指示条的 2px 与聚焦描边的 2px 是结构性描边宽度，其余颜色、间距、圆角、字体、动效全部引用 `--cb-*` 语义 token。
- `list-item.stories.tsx` 导出 `group`（StoryGroup 合同），包含四个用例：默认态、窄容器里超长标题与描述的截断边界态、无回调的纯 JSON 选中态、卡片内多行会话列表的真实组合。
- `list-item.test.tsx` 用 @testing-library/react 断言：纯 JSON props 渲染为 `div` 且各插槽内容齐全、只传 title 时不产出空插槽节点、传 `onClick` 时渲染为 `button` 并且鼠标点击与键盘回车都能触发回调、选中且可点击时类名与 `aria-current` 同时存在。
- `README.md` 是本说明文件。

## 与包内其他文件的关系

`ListItem` 经 `packages/ds/src/index.ts` 统一导出；`list-item.stories.tsx` 依赖上一级目录的 `story-types.ts` 提供的 StoryGroup 类型，并在真实组合用例里复用了 `card` 目录的 Card 组件。
