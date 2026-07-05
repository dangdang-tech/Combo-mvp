# modules —— 业务模块层

这个目录按业务领域拆成四个模块：`capability/` 负责能力的列表与加载，`session/` 负责会话与消息，`artifact/` 负责模型产出的成品（产物），`agent/` 负责一轮对话生成的编排与流式推送。每个带 HTTP 端点的模块内部统一分成三种文件：routes（端点声明与鉴权守卫）、handlers（薄壳处理器，校验入参并包响应信封）、repo 或 loader（SQL 与存储访问）；`agent/` 没有自己的 routes，它的流式端点挂在 session 模块的路由表里。

模块之间存在少量有向依赖：session 的处理器调用 capability 的加载器和 artifact 的产物列表查询，agent 的轮次编排调用 session 的消息读写和 artifact 的产物工具。所有模块向下只依赖 `platform/` 层提供的数据库句柄、对象存储、事件总线和鉴权中间件，向上由 `bootstrap/routes.ts` 统一注册到应用。
