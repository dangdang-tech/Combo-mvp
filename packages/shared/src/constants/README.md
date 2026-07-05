# constants — 路由常量

这个目录集中定义对外 HTTP 路径相关的常量，让后端挂路由和前端拼请求地址用同一份字符串。

## 文件

- `routes.ts` 定义 API 路由前缀 `API_PREFIX`（值为 `/api/v1`）、不带前缀的健康探针路径 `HEALTH_PATH` 与 `READY_PATH`，以及 `SSE_ROUTES`，后者是两个 SSE（服务端事件推送）端点的路径模板函数，分别指向任务进度流和试用会话的流式生成事件。
- `index.ts` 只做转出，把 `routes.ts` 的导出暴露给包入口。

## 上下游

runtime 和 authoring 都在 `bootstrap/routes.ts` 引用 `API_PREFIX` 作为业务路由前缀，都在 `platform/http/health.ts` 引用 `HEALTH_PATH` 和 `READY_PATH` 注册探针端点；authoring 的 `bootstrap/app.ts` 还用 `API_PREFIX` 做请求日志的路径判断。`SSE_ROUTES` 由 web 前端的 `apps/web/src/api/endpoints.ts` 引用来拼接任务进度流地址，两个后端服务没有直接引用它。
