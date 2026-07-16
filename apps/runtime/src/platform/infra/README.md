# platform/infra —— 外部资源客户端

这个目录负责全部外部资源的客户端封装：数据库连接池、Redis、对象存储、登录服务验签、模型选择和跨实例事件总线，并把常用的几个聚合成一个基础设施容器注入应用。客户端都是惰性创建，引入模块本身不发起连接。

## 文件

- `index.ts` 定义基础设施容器 InfraContext（环境变量、数据库句柄、对象存储、事件总线）和组装函数 buildInfra，并转发导出本目录其余文件的全部内容。
- `db.ts` 封装 PostgreSQL 连接池：定义各仓储统一依赖的最小数据库句柄类型（可直查、可领单连接开事务），提供 withTransaction 事务工具、SELECT 1 就绪探针和优雅关闭。
- `redis.ts` 惰性维护普通命令连接和专用订阅连接两个 ioredis 单例，提供 PING 就绪探针和统一关闭函数。订阅连接不执行普通命令。
- `redis-interrupt-bus.ts` 提供进程内与 Redis 两种打断广播总线。Redis 实现使用共享订阅连接监听固定频道，并把消息扇出给本进程的执行句柄；发布失败只影响本次尽力而为的打断。
- `object-store.ts` 封装对象存储（S3 协议，本地用 MinIO）：只实现读文本、读字节、写对象三个动作，另提供列举一条对象的就绪探针和关闭函数。
- `logto.ts` 封装登录服务（Logto）的令牌验签：经服务发现取公钥集验证 JWT 的签名、签发方、受众和有效期，把失败严格区分为「令牌无效」和「上游不可达」两类，并提供就绪探针和从令牌载荷提取角色、账号、邮箱的工具函数。
- `dev-session.ts` 是开发环境的种子登录验证分支：验证创作端签发的对称密钥 JWT，只在非生产且显式开启且密钥非空时可用，仅作为 Logto 判定无效后的兜底尝试。
- `redis-event-log.ts` 实现会话事件日志端口：按会话写入 Redis Stream，追加事件时刷新六小时有效期，并按 20000 条上限近似修剪；补发使用开区间和升序分批读取。
- `event-bus.ts` 实现 Redis 发布订阅直播：每个实例复用共享订阅连接，按会话频道引用计数并在进程内扇出。文件保留的内存实现只供单元测试使用。
- `llm.ts` 负责模型与凭据解析：支持 anthropic 直连和 openrouter 两种来源，来源未显式配置时按密钥存在性自动判定，模型 id 可用环境变量覆盖，并提供「是否配了可用密钥」的判定供就绪探针和轮次降级使用。

## 上下游

被谁使用：`bootstrap/app.ts` 调 buildInfra 组装容器并挂成 app.infra，同时创建 Redis 会话闸；业务处理器经 req.server.infra 取用；`platform/middleware/auth.ts` 用 `logto.ts` 和 `dev-session.ts` 验登录态；`platform/http/health.ts` 检查各项依赖；`modules/agent/build-agent.ts` 用 `llm.ts` 选模型；各模块的 repo 和 `modules/agent/` 消费数据库、对象存储、事件总线和会话闸。

依赖什么：向内引用 `platform/config/env.ts`；向外访问 PostgreSQL 数据库、不可驱逐的 redis_queue 实例、S3 协议对象存储和 Logto 登录服务，`llm.ts` 引用 pi-ai 包的内置模型注册表。
