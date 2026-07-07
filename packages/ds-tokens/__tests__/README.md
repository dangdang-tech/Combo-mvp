# `__tests__` 目录

本目录存放 ds-tokens 包的 vitest 测试，`pnpm -F @cb/ds-tokens test` 运行。

## canon-parity.test.mjs

包含两个测试。第一个是 canon 对齐测试：先执行一次 build.mjs，然后解析 apps/web/src/styles.css 的 `:root` 块里每一条 `--cb-*` 声明，断言 dist/tokens.css 的 `:root` 输出里存在同名变量且值完全一致。比较前会剥离注释并把连续空白归一成单个空格，`var()` 引用与 `color-mix()` 表达式原样保留参与比较。canon 是既成品牌，测试失败时应修 build 映射或 token 源值，不改 canon。第二个是幂等测试：连续执行两次 build.mjs，断言两次生成的 dist/tokens.css 内容哈希一致。
