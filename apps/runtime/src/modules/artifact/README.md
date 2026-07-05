# modules/artifact —— 产物

这个目录负责产物（模型产出的可独立留存成品，如网页、文档、代码、结构化数据）：给模型提供写产物的工具，给前端提供回读产物内容的端点。产物元数据存 artifacts 表，正文存对象存储，同一产物反复更新是原地覆盖，没有版本。

## 文件

- `routes.ts` 声明本模块唯一的端点：GET /runtime/artifacts/:id/content，挂 requireAuth 鉴权守卫。
- `handlers.ts` 实现内容回读处理器：先按当前用户做归属校验查出产物行，再从对象存储读回正文，按产物种类设置正确的 Content-Type 返回。
- `repo.ts` 封装 artifacts 表的 SQL：插入或原地更新一行、会话内查单个产物、列出会话全部产物、连表 sessions 做归属校验的读取；另外定义产物所在桶名、稳定的对象键生成规则和种类到 Content-Type 的映射。
- `tool.ts` 定义暴露给模型的 upsert_artifact 工具：模型调用时把正文写进对象存储、在 artifacts 表插入或更新一行、经回调通知上层发产物更新事件，返回给模型的只是简短回执而不回灌全文；模型带来的产物 id 只有真实存在于本会话才按更新处理，否则一律当新建。

## 上下游

被谁使用：`bootstrap/routes.ts` 注册本模块路由；`modules/agent/run-turn.ts` 在每轮生成时用 `tool.ts` 建产物工具挂给模型代理；`modules/session/handlers.ts` 在会话详情里调 `repo.ts` 的 listArtifacts 返回产物列表。

依赖什么：引用 `platform/infra/db.ts` 的数据库句柄类型和 `platform/infra/object-store.ts` 的对象存储接口，引用 `platform/middleware/auth.ts` 的鉴权守卫，引用 `platform/http/_helpers.ts` 的错误信封工具，引用 `modules/session/repo.ts` 的时间格式化函数。直接访问的外部资源是数据库的 artifacts 表（归属校验时连 sessions 表）和对象存储的 agora-artifacts 桶。

## 典型流程

以「前端回读一个产物的内容」（GET /runtime/artifacts/:id/content）为例：

1. 请求经 `routes.ts` 声明的端点进来，requireAuth 守卫先验登录态并把用户身份挂到请求上。
2. `handlers.ts` 的处理器调 `repo.ts` 的 readArtifactForOwner，用产物 id 连表 sessions 查行并校验会话归属；非本人或不存在都返回 404，不区分两种情况。
3. 处理器用查到的存储键从对象存储读回正文文本；对象存储不可用时返回依赖不可用的错误信封。
4. 按产物种类映射 Content-Type（如 html 对应 text/html），把正文以 200 直接返回，前端据此在画布里渲染或嵌入沙箱预览。
