# processes —— 进程入口

这个目录放可直接启动的进程入口。runtime 目前只有一个进程：api 进程既服务普通 HTTP 请求，也服务流式推送连接，对话生成同样在这个进程内异步执行。

## 文件

- `api.ts` 是 api 进程的主函数：先加载环境变量并启动观测（OpenTelemetry，一套链路追踪接线），再动态引入 `bootstrap/app.ts` 建应用并监听配置的端口，最后注册 SIGINT 与 SIGTERM 信号处理，收到信号时依次关应用、关观测、退出进程。

## 上下游

被谁使用：`src/index.ts`（包默认入口）直接引入本文件，因此 `node dist/index.js` 就是启动 api 进程。

依赖什么：引用 `platform/config/env.ts` 和 `platform/observability/node.ts`，并动态引入 `bootstrap/app.ts`；观测启动必须先于应用代码加载，这是动态引入的原因。
