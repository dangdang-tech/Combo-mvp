# modules/account — 登录与用户

这个模块负责登录域：对接 Logto（外部登录服务，OIDC 协议）完成授权码登录，维护 cb_session access-token Cookie 与 cb_refresh refresh-token Cookie，管理 users 表的首登建档，并提供当前用户信息接口。

## 文件

- `routes.ts` 声明五个端点：GET /auth/login（发起登录，无鉴权）、GET /auth/callback（登录回调，无鉴权）、POST /auth/refresh（只读 HttpOnly refresh Cookie，无 access-token 鉴权）、POST /auth/logout（尽力鉴权但永不拦）、GET /me（必须登录）；另外单独导出仅 dev/test 使用的 POST /auth/dev-login 种子登录端点，由 bootstrap/app.ts 条件注册。
- `handlers.ts` 实现上述端点：login 生成随机校验串并 302 跳转 Logto 授权页；callback 校验回跳参数、用授权码换 token、验签、首登建档、分别写入 cb_session/cb_refresh；refresh 验新 access token 后安全旋转两个 Cookie；logout 幂等清理两个会话 Cookie；me 读用户视图；dev-login 用应用自签的 HS256 token 造一个测试会话。
- `repo.ts` 收拢 users 表 SQL：provisionUser 按 Logto 的用户标识（sub）查或建 users 行，展示账号撞唯一键时自动追后缀消歧；readMe 读 /me 视图行。

## 上下游

被谁使用：路由由 `bootstrap/routes.ts` 挂载，dev-login 路由由 `bootstrap/app.ts` 条件挂载；`bootstrap/app.ts` 还把本模块的 provisionUser 注入 Fastify 实例（app.decorate），供 `platform/middleware/auth.ts` 的鉴权中间件在每个受保护请求上把验签结果换成业务用户 id（platform 不直接 import 业务域，走组合根接线）。

依赖什么：`platform/infra/logto.ts`（JWT 验签）、`platform/infra/logto-oidc.ts`（授权 URL 构建、authorization_code/refresh_token 换 token、回跳白名单）、`platform/infra/dev-session.ts`（种子会话签发与开关判定）、`platform/middleware/auth.ts`（会话 Cookie 名与守卫）、`platform/http/_helpers.ts`（错误信封）。外部资源：PostgreSQL 的 users 表（经 req.server.infra.db），以及 Logto 服务的授权、token、验签端点。

## 典型流程：GET /auth/callback（登录回调换会话）

1. 用户在 Logto 授权页登录后，浏览器带着授权码和 state 回跳到本端点，进入 `handlers.ts` 的 callbackHandler。
2. handler 读出登录前种下的短时事务 Cookie（cb_auth_tx），比对 state 防跨站伪造；对不上就 302 回登录页并只带一个随机 failureId，内部原因只落日志。
3. 调 `platform/infra/logto-oidc.ts` 的 exchangeCodeForToken，用授权码加 code_verifier 向 Logto 换回 access_token、id_token 和 refresh_token；授权请求固定带 offline_access + consent。
4. 若有 id_token，调 `platform/infra/logto.ts` 的 verifyLogtoIdToken 验签并比对 nonce；再用 verifyLogtoJwt 验 access_token，确保种进 Cookie 的 token 之后能被受保护端点识别。
5. 调 `repo.ts` 的 provisionUser：按 token 里的用户标识在 users 表做「不存在则插入、存在则更新最近登录时间和角色」，拿到业务用户 id。
6. 把 access_token 种进 cb_session Cookie（HttpOnly，8 小时），refresh_token 种进仅向 `/api/v1/auth` 发送的 cb_refresh Cookie，清掉短时事务 Cookie，302 回登录前记下的站内路径。

## 典型流程：POST /auth/refresh（会话续期）

1. 本端点不挂 requireAuth（access token 此时可能已过期），只从 HttpOnly cb_refresh Cookie 读 refresh token。
2. 向 Logto token endpoint 发 refresh_token grant，并继续带 `resource=LOGTO_AUDIENCE`。
3. 用 verifyLogtoJwt 验新 access token 的 iss/aud/exp；验过后写入新 cb_session，并优先保存 Logto 旋转后的最新 refresh token，成功返 204。
4. refresh 失败响应不清 Cookie，避免多 tab 并发时晚到的 invalid_grant 响应覆盖先到请求刚写入的有效新 Cookie；失效凭据由 logout 或下一次 login 覆盖。Logto/JWKS 短时不可达返安全 503。若 Logto 已旋转 refresh token 但 JWKS 临时不可达，只保存新 refresh token，绝不写入未验签的 access token。
