# platform/config —— 环境变量

这个目录负责进程环境变量的定义、加载与校验，是全服务配置的唯一入口。

## 文件

- `env.ts` 用 zod schema 定义全部环境变量及默认值（端口、日志级别、数据库连接串、对象存储地址与密钥、登录服务地址、模型密钥、跨域来源、开发登录开关等），并导出 loadEnv 函数：结果带缓存；生产模式缺关键配置直接抛错拒绝启动，开发与测试模式回落默认值并打警告；模型密钥不在生产必填之列，缺了只让对话轮次降级报错；开发登录开关在生产模式被无条件强制关闭。

## 上下游

被谁使用：`processes/api.ts` 和 `bootstrap/app.ts` 在启动时调 loadEnv；`platform/infra/` 各文件、`platform/observability/node.ts`、`modules/agent/build-agent.ts` 都消费这里导出的 Env 类型。

依赖什么：只依赖 zod 做校验和 process.env，本目录不引用项目内任何其他目录。
