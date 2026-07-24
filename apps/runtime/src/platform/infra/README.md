# platform/infra 外部资源与沙箱客户端

这个目录封装 Runtime 使用的数据库、Redis、对象存储、登录验签、模型选择和可选沙箱基础设施。功能关闭时只创建禁用的 SandboxBackend，不加载 Kubernetes 客户端模块，也不读取集群配置。

## 现有资源文件

- `index.ts` 组装数据库、对象存储、Redis 事件设施和 SandboxBackend。
- `db.ts` 封装 PostgreSQL 连接池、可取消事务、事务级锁等待与语句超时、就绪探针和关闭逻辑。
- `redis.ts`、`redis-interrupt-bus.ts`、`redis-event-log.ts` 和 `event-bus.ts` 负责 Redis 连接、跨实例打断、事件日志和实时直播。普通事件与带最后编号的开放标记由同一个 Redis 脚本写入；终态脚本把标记封闭并按 `runId` 幂等追加。标记缺失或仍是旧版 `OPEN` 时，脚本会先扫描保留的 Stream，发现终态后恢复标记并拒绝迟到普通事件。受 Session 行锁保护的修复模式可以用已提交的 PostgreSQL 终态替换升级前遗留的冲突事件；标记已经匹配但终态后仍有同一 Turn 普通事件时，它也会把数据库终态重放到 Stream 尾部。
- `object-store.ts` 封装 MinIO 或 S3 的对象读写，并让 Artifact 写入把中止信号传给 S3 客户端。
- `logto.ts` 和 `dev-session.ts` 负责生产登录验签与受限开发登录。
- `llm.ts` 负责模型来源、模型编号和 Runtime 内凭据选择。

## 沙箱文件

- `sandbox-backend.ts` 定义四个模型工具唯一可用的远程端口、稳定错误和默认禁用实现。这里没有宿主实现。
- `sandbox-capability.ts` 解析 Runtime 内的 Ed25519 私钥，为单次请求签发短期能力令牌，并只把公钥交给 Pod。
- `sandbox-client.ts` 调用 sandboxd 的 JSON 与 NDJSON 协议。普通 HTTP 请求、命令传输、响应、帧数量、线路大小和原始输出都有硬上限。Abort 会先等待认证取消确认，不能确认时要求后端回收 Pod。
- `kubernetes-sandbox-backend.ts` 先用 PVC 资源版本竞争固定槽位，再创建固定名称的 Pod，并校验标签、Pod UID、Ready 状态、配置指纹、经过 Kubernetes 默认化的容器安全规格和 Pod IP。它跟踪结果不明确的创建请求，并用 PVC 隔离标记和 Pod finalizer 等待节点确认容器终止后才释放固定 Local PVC 槽位。

## 授权与生命周期

每次文件或命令操作前，后端都会确认 Session 属于当前 owner、Session 仍为 active，并且指定 Turn 仍为 running。固定 PVC 的原子预留在同一个 Session 共享行锁内完成，因此终态清理不会漏掉刚开始的 Pod 分配。文件操作在完成前持续持有共享行锁，命令操作持续持锁到 sandboxd 返回启动帧；Turn 终态事务必须取得同一行的排他锁，因此认证完成后不会再有越过终态的新副作用。Pod 启动后还会执行认证的协议握手。能力令牌、私钥、Kubernetes 客户端和模型凭据都不会进入模型参数或命令环境。

两个 Runtime 副本使用固定 PVC 上的 Session、分配编号和状态标记裁决槽位。PVC 更新带资源版本前提，只有一个副本能从空闲状态切换到预留状态。Pod 创建成功后，同一个分配编号和 Pod UID 会把 PVC 切换为占用状态。每个 Pod 记录正整数配置修订号。较新修订会在 Session 行锁和真实 running Turn 检查后按 UID 替换较旧 Pod；较旧副本不能删除较新 Pod。相同修订对应不同配置指纹时，双方都不会互相替换，调用会失败关闭并等待配置修正。

Kubernetes 的 PVC 和 Pod 读取、创建、删除、修补和列表操作都使用真实 AbortSignal，并由后端硬超时限制。每次创建带随机分配编号；本地超时后仍保留原请求 Promise 和 PVC 预留状态，迟到创建会按分配编号回收。Pod 删除使用 UID 与资源版本前置条件。

固定 Pod 带有 finalizer。后端在请求删除前先把对应 PVC 切换为隔离状态。删除请求被接受后，后端必须从同一个 Pod UID 看到主容器和初始化容器都进入终止状态，随后才移除 finalizer 并等待 UID 消失。只有这些步骤全部完成，后端才清除 PVC 上的分配标记。节点失联、对象提前消失或终止状态无法确认时，后端返回清理未确认错误，PVC 标记继续阻止其他副本复用该槽位。API 对象消失本身不再被当成进程和挂载已经结束的证明。

本地命令取消成功只表示 sandboxd 已完成最终后代扫描。若取消、断流或协议失败，客户端会要求后端执行上述节点确认删除。删除仍无法确认时，Pi 工具会中止 Turn，当前 `running` 守卫不会释放。功能关闭的 Runtime 只知道自己的本地 Turn 没有远程工具，不能替其他副本证明沙箱已经清理。

普通容量是四个槽位。第五槽只有在独立维护清单和显式验证开关同时启用时才可分配。Pod 空闲十五分钟后可以回收，`activeDeadlineSeconds` 与清扫器共同把绝对生命周期限制在三十分钟内。Session 归档提交后异步回收工作区，不延迟已经成功的 HTTP 响应。
