# skeleton 目录

本目录实现设计系统的骨架屏占位组件 Skeleton，用于数据加载期间以呼吸动画的灰块占住内容的位置。组件接收 variant（'text'、'block'、'circle' 字符串联合枚举，默认 'text'）、width 与 height（可选自由字符串，属于结构尺寸）三个 props。text 变体默认高一行文字并占满容器宽度，block 变体是圆角矩形区块，circle 变体是圆形。元素带 aria-hidden，对辅助技术隐藏。

目录内各文件的职责如下。skeleton.tsx 是组件实现，定义 SkeletonVariant 联合类型与 SkeletonProps 接口并导出 Skeleton 函数组件，width 与 height 通过行内样式覆盖变体默认尺寸。skeleton.css 是组件样式，底色使用 --cb-skeleton token，呼吸式 opacity 动画的时长由 motion token（--cb-duration-slow 乘以系数）推导、缓动使用 --cb-ease-standard，各变体圆角分别取 --cb-radius-control、--cb-radius-card 与 --cb-radius-pill，并在用户偏好减少动效时关闭动画。skeleton.stories.tsx 按仓库轻量 story 合同导出 group 对象，包含默认态、三种变体加自定义尺寸的边界态、模拟会话列表项加载的组合态。skeleton.test.tsx 断言空 props（纯 JSON）可渲染出默认 text 变体、变体类名映射正确、width 与 height 写入行内样式、aria-hidden 属性存在。
