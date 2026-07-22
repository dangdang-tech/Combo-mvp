# Runtime 源码测试

这个目录保存 Runtime 的单元测试和忠实假件。测试不连接生产数据库、Redis、对象存储或 Kubernetes 集群；需要真实 PostgreSQL、Redis 或 Docker 的验证由仓库集成脚本负责。

## 文件职责

- `fakes.ts` 提供与当前仓储 SQL 守卫一致的内存数据库、Redis 事件日志、对象存储和 Pi Agent 假件。
- `artifact.test.ts` 验证 Artifact 暂存对象、运行中 Turn 条件提交、中断栅栏、Studio HTML 契约、UI revision 和 Session 快照。
- `build-agent.test.ts` 验证系统提示词、历史消息和模型接线。
- `loader.test.ts` 验证 Capability 归属、发布可见性和定义加载。
- `routes.test.ts` 验证 Runtime 端点声明、错误信封、普通与 Studio Session、会话归档、UI 恢复和 Artifact 内容读取。
- `run-turn.test.ts` 验证 Turn 创建、模型执行、Studio 成功提升、事件顺序、终态收尾、打断、超时和关闭截止时间。
- `session-repo.test.ts` 验证 Session 与 Message 的归属条件、排序和状态处理。
- `stream-events.test.ts` 验证 Redis Stream 编号、断线补发、实时缓冲和去重。
- `turn-control.test.ts` 验证单 Session 单运行 Turn、开轮提交窗口、跨副本终态栅栏、功能启停混合副本和超时清扫。
- `turn-repo.test.ts` 验证 Turn 仓储的唯一冲突映射、条件收尾和锁序。
- `sandbox-backend.test.ts` 验证 Kubernetes Pod 身份、安全规格、PVC 原子分配、强制删除后的槽位隔离、节点终止 finalizer、迟到创建协调和有界关闭。
- `sandbox-capability.test.ts` 验证沙箱能力令牌的签名材料、声明绑定和有效期。
- `sandbox-client.test.ts` 验证 sandboxd 的认证请求、线路限制、命令流、取消和协议错误。
- `sandbox-config.test.ts` 验证沙箱默认关闭、启用必填项、四槽默认值和第五槽门禁。
- `sandbox-tools.test.ts` 验证四个 Pi 工具只调用 SandboxBackend，并把远端错误转换为稳定结果。
