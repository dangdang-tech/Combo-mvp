# platform/infra/llm — 大模型网关

这个目录实现统一的大模型调用网关：一次调用统一套上限流、分级超时、退避重试、降级兜底和用量审计。上游支持 Anthropic 直连和 OpenRouter（OpenAI 兼容转发服务）两个来源，缺密钥或上游持续不稳时返回降级结果而不是抛错，保证主链路可跑。

## 文件

- `index.ts` 是装配入口：resolveLlmProvider 按环境变量（显式指定优先，否则看哪家密钥在）选上游并建 SDK 客户端，缺密钥时给 null（全降级）；createLlmGateway 把 SDK、进程内令牌桶限流器和 PG 审计落库器装配成网关；probeLlm 供 /ready 探针报 ok 或 degraded。
- `gateway.ts` 是网关核心：makeLlmGateway 返回 complete/stream/embed 三个方法；executeGoverned 对每次调用依次执行限流判定、带 AbortController 的超时控制、按错误分类的退避重试（上限来自共享包常量），重试耗尽或致命错误统一降级并记审计；流式路径不整体重试，超时或断流就降级收尾；embed 本期未接真端点，直接返回降级结果。
- `types.ts` 放内部类型与常量：默认模型名、各模型的成本估算价目表和 computeCostMicros、错误分类（可重试/降级/致命）、审计记录、限流器与时钟的注入接口。
- `errors.ts` 把 Anthropic SDK 和网络异常归一成内部分类：429 可重试并读 retry-after，鉴权和输入类错误致命不重试，5xx 和连接错误可重试；另提供指数退避加抖动的等待时长计算。
- `openrouter.ts` 是 OpenRouter 适配器：用 fetch 调 /chat/completions（含 SSE 流式），把响应翻译成 Anthropic SDK 的消息与流事件形态，让 gateway.ts 不感知上游差异。
- `openrouter-errors.ts` 定义 OpenRouterApiError 并按 HTTP 状态码归一成与 Anthropic 路径一致的内部分类。
- `limiter.ts` 提供进程内令牌桶限流器（每键每分钟 60 次）和永放行的空实现；跨实例一致限流尚未实现，createRedisRateLimiter 目前也回落令牌桶。
- `audit.ts` 提供审计落库器：createPgAuditSink 把每次调用（成功和降级都记）的 token 用量、估算成本、重试次数写进 audit_llm_calls 表，写失败只回调日志不阻塞主调用；另有空实现和单测用的内存收集器。

## 上下游

被谁使用：`platform/infra/llm-gateway.ts` 转出本目录的 createLlmGateway 和 probeLlm，进而被 `platform/infra/index.ts`（api 进程容器）和 `platform/http/health.ts`（就绪探针）使用；`processes/worker.ts` 直接调 createLlmGateway、resolveLlmProvider 和 createPgAuditSink；`modules/task/extract.ts` 通过注入的网关端口调 complete 并用本目录的 LlmAuditSink 类型记账。

依赖什么：`platform/config/env.ts`（配置）、@anthropic-ai/sdk、全局 fetch。外部资源：Anthropic API 或 OpenRouter API（按配置二选一），以及 PostgreSQL 的 audit_llm_calls 表。
