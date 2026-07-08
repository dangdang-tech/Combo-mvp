# `__tests__` 目录

本目录存放 ds-tokens 包的 vitest 测试，`pnpm -F @cb/ds-tokens test` 运行。

## canon-parity.test.mjs

包含两个测试。第一个是构建幂等测试：连续执行两次 build.mjs，断言两次生成的 dist 产物（tokens.css 与 tokens.flat.json）内容哈希一致。第二个是消费链路测试：读取 apps/web/src/main.tsx 与 apps/runtime-web/src/main.tsx 两个入口文件，断言它们都 import 了 `@cb/ds-tokens/tokens.css`，确保两个前端 app 确实从本包的构建产物取用 `--cb-*` 变量。两个前端 app 已改为在入口直接消费 dist/tokens.css，不再在各自 styles.css 的 `:root` 里手工自存一份 canon，因此早先解析 apps/web/src/styles.css `:root` 与 dist 逐值比对的 canon 对齐测试已随 canon 消失而删除。
