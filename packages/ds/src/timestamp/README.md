# timestamp 目录

本目录实现时间戳组件，对外导出 `Timestamp` 组件以及 `formatRelative`、`formatAbsolute` 两个纯函数。

`Timestamp` 渲染一个 `time` 元素，使用等宽字体和弱化色。它接受四个 prop：`value` 是 ISO 8601 时间字符串；`mode` 在 `absolute` 与 `relative` 两个字符串枚举里选一个，默认 `absolute`，前者显示「YYYY-MM-DD HH:mm」，后者显示「刚刚」「x 分钟前」「x 小时前」「x 天前」这样的相对文案；`locale` 默认 `zh-CN`，以 `zh` 开头时相对文案输出中文，其余输出英文；`now` 是可选注入的「当前时间」ISO 字符串，只在 relative 模式下使用，不传时取真实当前时间，注入它可以让渲染结果确定，方便测试和 story 展示。无论哪种模式，`title` 属性永远放带秒的完整绝对时间，`dateTime` 属性放原始的 `value`。

相对文案由独立导出的纯函数 `formatRelative(value, now, locale?)` 计算，不依赖任何第三方库，当前时间由调用方注入。不满一分钟和未来时间统一显示「刚刚」，分钟、小时、天三档按整数向下取整。`formatAbsolute(value)` 把 ISO 字符串格式化为本地时区的「YYYY-MM-DD HH:mm」。两个函数遇到无法解析的输入都原样返回输入字符串，组件因此会把非法数据直接透出，方便排查上游问题。

## 文件说明

- `timestamp.tsx`：`Timestamp` 组件、`formatRelative` 与 `formatAbsolute` 纯函数，以及 `TimestampProps` 类型导出。
- `timestamp.css`：组件样式，类名是 `cb-timestamp`，字体、字号、颜色全部引用 `--cb-*` 语义 token，并开启表格数字对齐和禁止换行。
- `timestamp.stories.tsx`：story 用例集合，覆盖默认绝对时间、注入固定 now 的相对时间阶梯、非法输入与未来时间的边界形态，以及会话列表行的真实组合。
- `timestamp.test.tsx`：单元测试，覆盖 `formatRelative` 与 `formatAbsolute` 的各档文案和非法输入行为，并断言组件用纯 JSON props 可渲染、title 与 dateTime 属性正确、locale 生效。
