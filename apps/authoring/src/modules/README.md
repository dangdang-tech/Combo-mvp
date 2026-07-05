# modules — 业务模块层

这个目录按业务领域分成三个模块：`account/` 管登录、会话和用户表，`task/` 管任务生命周期、助手上传与提取流水线，`capability/` 管能力项的读取与发布。每个模块内部固定三件套：`routes.ts` 声明端点和鉴权守卫，`handlers.ts` 是薄壳（校验入参、调服务或仓储、包响应信封），`repo.ts` 收拢该模块的全部 SQL；task 模块因为逻辑最重，另有状态机服务、配对上传、流水线、会话解析等专属文件。

所有模块的路由由 `bootstrap/routes.ts` 统一挂到 `/api/v1` 前缀下；模块之间只有两处横向引用：task 的流水线落库时调 capability 的 insertCapability，task 和 capability 的 repo 复用 account/repo.ts 的时间格式化函数 toIso。模块层向下只依赖 `platform/` 的基础设施端口和共享包 `@cb/shared` 的类型与错误码。
