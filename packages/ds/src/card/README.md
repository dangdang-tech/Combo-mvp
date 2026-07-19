# card

本目录实现设计系统的通用卡片容器组件 Card。卡片是一个纯展示容器，所有视觉状态都由两个字符串枚举 prop 决定：`variant` 取 `surface`、`raised`、`hero` 三档，`padding` 取 `none`、`md`、`lg` 三档，因此任意视觉状态都可以用纯 JSON props 表达。组件不接收任何回调，也没有内部状态。

## 文件说明

- `card.tsx` 导出 `Card` 组件以及 `CardProps`、`CardVariant`、`CardPadding` 类型。组件渲染一个 `div`，类名由 `cb-card` 加上变体类（如 `cb-card--hero`）和内边距类（如 `cb-card--pad-md`）组成。
- `card.css` 定义三种变体的底色、描边、圆角与阴影，以及三档内边距。所有颜色、圆角、阴影、间距都引用 `--cb-*` 语义 token；surface 变体的 1px 描边是结构性描边宽度，描边颜色使用 `--cb-line-2`。
- `card.stories.tsx` 导出 `group`（StoryGroup 合同），包含四个用例：surface 默认态、raised 变体、无内边距加超长文本的边界态、hero 首屏真实组合。
- `card.test.tsx` 用 @testing-library/react 断言：纯 JSON props（不含函数）能渲染出正确内容与类名、默认值是 surface 加 md、各变体类名互斥正确、嵌套 ReactNode children 原样渲染。
- `README.md` 是本说明文件。

## 与包内其他文件的关系

`Card` 经 `packages/ds/src/index.ts` 统一导出；`card.stories.tsx` 依赖上一级目录的 `story-types.ts` 提供的 StoryGroup 类型，供 demo 画廊消费。
