# scripts 目录

本目录存放 ds-tokens 包构建流程里的两个校验脚本，`pnpm -F @cb/ds-tokens build` 会在构建产物生成后依次执行它们，任一校验失败都会让构建以退出码 1 结束。

## check-alias-only.mjs

语义层纯引用校验。脚本扫描 tokens/semantic.json 与 tokens/motion.json（两者共同构成语义层），要求每个 token 的 `$value` 要么是形如 `{xx.yy}` 的单个引用字符串，要么是 `light` 与 `dark` 两个键的对象且每个模式值都是单个引用。发现任何裸值、未知模式键或非法形态就打印明细并以退出码 1 结束。

## check-mode-parity.mjs

双模式齐备校验。脚本同样扫描语义层两份文件，确保每个 color 语义 token 在 light 与 dark 两个模式下都有值：`$value` 是对象的必须同时给出 light 与 dark；`$value` 是单个引用字符串的视为模式无关（别名与 color-mix 配方在两个模式下输出同一个 `var()` 表达式），同时计入两个模式。light 与 dark 覆盖集合的差集非空时打印缺失项并以退出码 1 结束。
