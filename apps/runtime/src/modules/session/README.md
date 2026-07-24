# modules/session 会话与消息

这个目录负责普通与 Studio Session 的创建或复用、列表、详情、改名、归档、消息提交和打断。Session 与 Message 继续落在原有表中，所有归属查询都带 owner 条件，非本人和不存在返回相同结果。

## 文件

- `routes.ts` 声明普通 Session、Studio 入口及登录守卫。普通端点使用登录鉴权，SSE 端点只接受同源 Cookie。
- `handlers.ts` 校验输入、读取 owner-scoped Session、加载能力并调用 TurnRunner。Studio 入口只允许 Capability 创作者，复用唯一 active Studio Session，并恢复当前 UI 或迁移合规旧页面；新普通 Session 会复制创建时的 UI 快照。消息提交仍返回 202；数据库唯一约束冲突使用现有 `SESSION_BUSY` 409 信封。归档事务提交后会异步尽力删除该 Session 的临时沙箱 Pod，沙箱回收卡住或失败都不会延迟或改变已经成功的归档响应。
- `repo.ts` 封装普通与 Studio Session 以及 Message SQL。开始 Turn 和归档共用 Session 行锁；归档会拒绝仍有运行 Turn 的 Session。消息按 Turn 和轮内位置写入，详情读取时派生连续对外序号。
- `message-content.ts` 严格校验 user、assistant 和 tool 三类原生消息块，坏内容不会进入历史。

沙箱工作区不是 Session 的持久化真源。Pod 存活时同一 Session 可以复用临时文件；Pod 删除后该 Session 不再能访问槽位，下一个 Pod 启动前必须先擦除固定 PVC。Session、Message、Artifact 和 Redis SSE 的恢复行为不依赖该目录。
