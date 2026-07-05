# platform/config — 环境配置

这个目录负责进程环境变量的加载与校验，是全服务配置的唯一入口。

## 文件

- `env.ts` 用 Zod schema 定义并解析全部环境变量（进程类型、端口、日志级别、PostgreSQL、双 Redis、MinIO、Logto、大模型网关、链路追踪、dev 种子登录开关），导出 loadEnv（带缓存）和 Env 类型。生产模式下按进程类型（api 或 worker）检查各自的必填密钥集，缺失直接启动失败，绝不带默认凭据上生产；dev/test 允许回落默认值但会打警告。容器编排注入的空字符串会被规整成未设置，让「留空即默认」语义成立；生产下即便误配了 DEV_LOGIN_ENABLED=true 也会被强制关回。

## 上下游

被谁使用：`processes/api.ts`、`processes/worker.ts`、`bootstrap/app.ts` 在启动时调 loadEnv；`platform/infra/` 下所有客户端工厂、`platform/observability/node.ts`、`platform/middleware/` 相关代码都以 Env 类型接收配置。

依赖什么：只依赖 zod 和 process.env，不访问任何外部资源，也不 import 本仓库其它目录。
