# platform/config 环境变量

这个目录是 Runtime 配置的唯一入口。`env.ts` 使用 zod 定义数据库、Redis、对象存储、登录、模型、跨域、观测和可选沙箱配置。

沙箱工具默认关闭。关闭时不加载 Kubernetes 客户端模块，也不要求镜像、签名私钥或集群权限。显式开启后，sandboxd 镜像必须使用 SHA-256 摘要，签名私钥必须存在，RuntimeClass 固定为 `gvisor`。任何缺项都会让进程启动失败，不会回退到宿主文件或进程实现。

`SANDBOX_CONFIGURATION_REVISION` 是正整数。镜像、公钥、容量或 Pod 安全规格变化时必须递增它。较旧 Runtime 看到较新修订的 Pod 时只会拒绝使用，不会删除或回滚；相同修订却出现不同配置指纹时也会失败关闭，防止两个副本反复互删。

普通容量是四个固定槽位。代码最多识别第五个槽位，但 `SANDBOX_CAPACITY=5` 只有与 `SANDBOX_FIFTH_SLOT_VALIDATED=true` 同时出现时才通过校验。这个开关对应独立维护清单，普通清单不会设置它。

Pod 默认空闲十五分钟回收，绝对生命周期默认且最多为三十分钟。命令默认超时是 120 秒，单条命令允许的最大值是 300 秒。Runtime 关闭默认使用十五秒总截止时间，Turn 收尾、数据库查询、沙箱后端和基础设施连接共用这个截止时间。

| 变量                             | 当前含义                                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| `RUNTIME_SHUTDOWN_TIMEOUT_MS`    | 这个变量指定 Runtime 全链路关闭的绝对时限，默认是 15000 毫秒。         |
| `SANDBOX_TOOLS_ENABLED`          | 这个变量控制是否创建 Kubernetes 后端并注册四个模型工具，默认关闭。     |
| `SANDBOX_NAMESPACE`              | 这个变量指定按需 sandboxd Pod 所在命名空间，默认是 `combo-sandbox`。   |
| `SANDBOX_CONFIGURATION_REVISION` | 这个正整数标识沙箱配置修订，默认值是一。                               |
| `SANDBOX_IMAGE`                  | 这个变量指定 sandboxd 的不可变摘要镜像，开启功能时必填。               |
| `SANDBOX_CAPABILITY_PRIVATE_KEY` | 这个变量保存 Ed25519 PKCS#8 PEM 或 DER 的标准 Base64，只留在 Runtime。 |
| `SANDBOX_CAPACITY`               | 这个变量指定固定槽位数量，普通值是四，受控最大值是五。                 |
| `SANDBOX_FIFTH_SLOT_VALIDATED`   | 这个变量记录第五槽已经完成真实集群验证，默认关闭。                     |
| `SANDBOX_RUNTIME_CLASS`          | 这个变量固定为 `gvisor`。                                              |
| `SANDBOX_COMMAND_TIMEOUT_MS`     | 这个变量指定默认命令超时，最大值是 300000 毫秒。                       |
| `SANDBOX_STARTUP_TIMEOUT_MS`     | 这个变量限制等待按需 Pod Ready 的时间。                                |
| `SANDBOX_IDLE_TTL_MS`            | 这个变量指定没有运行 Turn 时允许保留工作区的空闲时间。                 |
| `SANDBOX_ABSOLUTE_TTL_MS`        | 这个变量限制 Pod 绝对生命周期，最大值是 1800000 毫秒。                 |
| `SANDBOX_SWEEP_INTERVAL_MS`      | 这个变量指定跨 Runtime 副本检查空闲和过期 Pod 的周期。                 |
