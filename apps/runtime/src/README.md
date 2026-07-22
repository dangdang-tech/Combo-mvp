# runtime 服务源码总览

这个目录是能力运行与界面设计端的后端源码。服务负责登录态校验、Capability 加载、普通与 Studio Session、Turn 管理、模型生成、Redis SSE 和 Artifact。模型驱动的文件与命令操作在功能开启时由独立 sandboxd Pod 完成，Runtime 源码不访问宿主工作区，也不启动宿主子进程。

## 文件与目录

- `index.ts` 加载 `processes/api.js`，作为包的默认启动入口。
- `bootstrap/` 组装环境变量、基础设施容器、TurnRunner、Fastify 插件、错误处理、健康检查和业务路由。
- `processes/` 保存进程入口，目前只有一个 API 进程。
- `modules/` 保存 capability、session、artifact 和 agent 四个业务模块，其中 Studio 模式复用同一套 Turn 与事件机制。
- `platform/` 保存配置、数据库、Redis、对象存储、登录验签、模型选择、沙箱后端、HTTP 公共设施和观测接线。
- `__tests__/` 保存 Runtime 单元测试以及数据库、事件日志、对象存储和 Pi Agent 忠实假件。

## 消息提交路径

用户提交消息后，Session 处理器会重新校验归属并加载 CapabilityDefinition。TurnRunner 在事务中锁定 active Session，插入一个 `running` Turn 和轮内用户消息。数据库部分唯一索引保证同一 Session 只有一个运行轮次；冲突会映射为现有 `SESSION_BUSY` 信封。

异步执行开始后，TurnRunner 读取已完成历史，先挂载可信的 `upsert_artifact`，再在功能开启时追加 `read`、`write`、`edit`、`bash` 四个串行工具。Studio Turn 会校验 HTML revision，并只在整轮成功时原子更新 Capability 当前 UI。模型文本和产物状态继续写入 Redis 事件日志并直播给 SSE 连接，完成消息继续落入 PostgreSQL。
