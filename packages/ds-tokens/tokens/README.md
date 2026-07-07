# tokens 目录

本目录存放 Combo 设计 token 的三份 DTCG 格式 JSON 源文件，是整个设计系统取值的唯一出处。每个 token 节点都带 `$type` 与 `$value` 两个字段。

## primitives.json（原料层）

存放全部裸值，按原料分组：

- `color.ink` 是墨色阶，包含 canon 前景色 #1c1b19 与暗色模式各级底面用的深墨色。
- `color.paper` 是暖纸阶，包含纯白、canon 纸底 #fbfaf6、卡面 #fafbf8、侧栏灰 #f7f7f7，以及暗色模式前景用的浅纸色。
- `color.sage` 是绿灰阶，包含页面底、软底、三级分隔线、次要文字色，以及暗色模式的分隔线深绿灰。
- `color.brick` 是砖红阶，覆盖品牌强调色的 soft、tint、hover、pressed 全档与暗色模式提亮档。
- `color.moss`、`color.green`、`color.amber`、`color.red` 分别是聚焦环青绿、成功绿、警示赭黄、危险红，各含 light 用深档与 dark 用亮档。
- `color.alpha` 存放两个带透明度的网格纸底色。
- `color.mix` 存放四条 color-mix 配方字符串（ok-soft、warn-soft、danger-soft、danger-line）。配方内嵌 `{semantic.*}` 引用，构建时被替换成 `var(--cb-*)`；混合比例等字面参数属于配方本身，所以放在原料层而不是语义层。
- `font.family` 是四个字体族栈（品牌字标、衬线标题、无衬线正文、等宽 label），`font.size` 是七档字号阶梯（12、13、14、16、20、28、40 像素），由 apps/web 与 apps/runtime-web 现有 CSS 里 font-size 的实际用量归纳而来。
- `space` 是八档间距阶梯，取 4、8、12、16、24、32、40、48 像素。
- `size.sidebar` 是侧栏展开与收起宽度。
- `radius` 是四档圆角刻度。
- `shadow.ink` 是 light 模式墨色 tint 三档阴影，`shadow.black` 是暗色模式的三档提案阴影。
- `motion.duration` 是三档动效时长（120、200、320 毫秒），`motion.easing` 是标准与减速两条缓动曲线。

## semantic.json（语义层）

以扁平 key 定义全部语义 token，key 即 CSS 变量名去掉 `--cb-` 前缀后的部分。每个 `$value` 都是纯 `{}` 引用；color 与 shadow 类 token 的 `$value` 是含 `light` 与 `dark` 两个引用的对象，别名（border、badge-ok）与 color-mix 配方类 token 是单个引用字符串，两个模式下天然一致。dark 引用指向的取值是 v1 提案，尚未经人工调校。

## motion.json（语义层的动效部分）

存放五个动效语义 token（三档时长与两条缓动曲线），格式与 semantic.json 相同，构建与校验时与 semantic.json 合并处理。
