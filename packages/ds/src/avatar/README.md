# avatar 目录

本目录实现设计系统的圆形头像组件 Avatar，以及独立导出的首字母提取纯函数 initialsOf。组件接收 name（必填显示名，同时用作无障碍标签）、src（可选图片地址）与 size（'sm'、'md'、'lg' 字符串联合枚举，默认 'md'）三个 props。src 缺失、为空串或图片加载失败时，组件回退显示 initialsOf(name) 的结果：中文名取第一个字，英文多词名取首尾两个词的首字母大写，单词名只取首字母大写。回退底色按 name 的稳定 hash 从 --cb-muted-bg、--cb-accent-soft、--cb-ok-soft 三种柔和 token 中挑选，同一个 name 每次渲染得到相同底色。

目录内各文件的职责如下。avatar.tsx 是组件实现，导出 Avatar 组件与 initialsOf 函数，内部用 useState 记录加载失败的 src 以触发回退，src 变化时自动恢复尝试显示图片。avatar.css 是组件样式，圆形轮廓用 --cb-radius-pill，三档尺寸的宽高取 --cb-space-5、--cb-space-6、--cb-space-7，首字母使用 --cb-font-mono 等宽字体，图片以 cover 方式填满容器。avatar.stories.tsx 按仓库轻量 story 合同导出 group 对象，包含中文名默认态、回退边界态（英文名、单词名、失效图片地址）、三档尺寸混排图片与回退的组合态。avatar.test.tsx 覆盖 initialsOf 的中文、英文多词、单词、空白输入，以及组件的纯 JSON props 渲染、底色稳定性、图片渲染、加载失败回退与尺寸类名映射。
