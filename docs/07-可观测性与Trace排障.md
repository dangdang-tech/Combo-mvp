# 可观测性与 Trace 排障

本仓库的排障码就是对外 `traceId`。用户在错误态看到反馈码后，研发可用同一个 ID 在 Grafana 里关联前端错误、HTTP 请求、后台任务日志和 Tempo trace。

## 组件

- OpenTelemetry Collector：接收 OTLP traces，并 tail Docker stdout/stderr 日志。
- Loki：存结构化日志。应用日志中的 `traceId`、`trace_id`、`span_id` 保持为 JSON 字段，不作为高基数 label。
- Tempo：存 OpenTelemetry traces。
- Grafana：预置 Loki/Tempo 数据源和 `Trace Debug` dashboard。

官方参考：

- OpenTelemetry Context Propagation: https://opentelemetry.io/docs/concepts/context-propagation/
- Loki OTLP: https://grafana.com/docs/loki/latest/send-data/otel/
- Tempo: https://grafana.com/docs/tempo/latest/

## Trace ID 约定

- 对外反馈码：UUID 字符串，字段名 `traceId`。
- HTTP 请求头：`x-trace-id`。
- W3C Trace Context：`traceparent`。
- HTTP 响应头：`x-trace-id` + `traceparent`。
- ErrorEnvelope / SSE error：继续使用 `error.traceId`。
- OpenTelemetry 内部 trace id：同一个 UUID 去掉连字符后的 32 位 hex，日志字段名 `trace_id`。

优先级：

1. `traceparent`
2. `x-trace-id`
3. `?traceId=`（仅用于原生 EventSource 无法加 header 的兜底）
4. 当前 OTel span
5. 新 UUID

## 本地启动

compose 栈会启动：

- Grafana: http://localhost:3003
- Loki: http://localhost:3100
- Tempo: http://localhost:3200
- OTel Collector OTLP HTTP: http://localhost:4318

`.env.compose.example` 需要填 `GRAFANA_ADMIN_PASSWORD`。`scripts/start.sh` 会拒绝空值和弱默认值。

## 按反馈码排障

1. 打开 Grafana: `http://localhost:3003/d/agora-trace-debug/trace-debug`。
2. 在 `Trace ID` 输入用户提供的反馈码。
3. 查看同一 `traceId` 下的前端 client event、API 日志、worker/consumer/sweeper 日志。
4. 在 Explore -> Tempo 中输入同一 trace，查看 HTTP/PG/fetch 等 spans。
5. 从 Tempo trace 跳转 Loki 日志时，确认查询字段为 `trace_id` 或 `traceId`。

## 接入点

- 后端入口在 `platform/observability/node.ts`，仅当 `OTEL_EXPORTER_OTLP_ENDPOINT` 有值且 `OTEL_SDK_DISABLED != true` 时启动。
- Fastify 入口继承/生成 traceId，并在响应头、错误信封和结构化日志中写入同一 ID。
- 前端 API client 和 SSE client 会发送 `x-trace-id` + `traceparent`。
- 前端全局错误、API 错误、SSE 错误会投递到 `POST /api/v1/client-events`，该端点只写日志、不写库。
