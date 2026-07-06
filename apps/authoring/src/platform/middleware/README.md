# platform/middleware — 鉴权中间件

这个目录放请求鉴权的 preHandler 守卫：从请求里取出会话凭证、验签、把业务用户 id 注入 req.auth。

## 文件

- `auth.ts` 提供三个守卫和相关工具。requireAuth 从 Authorization Bearer 头（优先）或 cb_session Cookie 取 token，走 Logto JWT 验签；验签判无效且 dev 种子登录可用时再试一次应用自签的 dev 会话验签；通过后调组合根注入的 provisionUser（本文件只声明 ProvisionUserFn 函数形状，实现在 account 域、由 `bootstrap/app.ts` 以 app.decorate 接线——platform 领域无关，不 import 业务域）查或建 users 行，把业务用户 id（不是 Logto 的 sub）放进 req.auth。requireSseAuth 是 SSE 端点专用：只认同源 Cookie，带 Bearer 头或 query token 直接 401，失败在建流前以 HTTP 错误返回。bestEffortAuth 给 logout 专用：能解出会话就注入，任何失败都放行绝不拦。失败分类明确：无 token 或 token 无效返 401，Logto 上游不可达返 503（不可达不等于鉴权失败），建档数据库异常返 500。文件里还导出会话 Cookie 名 SESSION_COOKIE 和 owner 断言函数 isOwner。

## 上下游

被谁使用：`modules/account/routes.ts`（/me 用 requireAuth，logout 用 bestEffortAuth）、`modules/task/routes.ts`（任务端点用 requireAuth，进度 SSE 用 requireSseAuth）、`modules/capability/routes.ts`（全部用 requireAuth）；`modules/account/handlers.ts` 引用 SESSION_COOKIE 种和清会话 Cookie。

依赖什么：`platform/infra/logto.ts`（verifyLogtoJwt 验签）、`platform/infra/dev-session.ts`（dev 会话开关判定与验签）、`platform/http/_helpers.ts`（sendError 错误信封）；provision 实现不直接依赖——经 Fastify 实例上组合根注入的 provisionUser 间接触达 users 表。间接触达 Logto 的 JWKS 端点。
