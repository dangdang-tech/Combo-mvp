# platform/middleware —— 鉴权中间件

这个目录只有一个文件，负责把「验登录态」做成可挂在任意端点前面的守卫：验证创作端登录后写入的 cb_session Cookie，查 users 表解出业务用户 id，挂到 req.auth 上。

## 文件

- `auth.ts` 提供两个守卫工厂。requireAuth 用于普通 HTTP 端点：优先取 Authorization 头的 Bearer 令牌，否则取会话 Cookie，先走 Logto 验签，判定无效时再尝试开发登录兜底分支，验签通过后查 users 表构造鉴权上下文；runtime 不创建用户，库里查无此人一律按未登录处理。requireSseAuth 用于流式端点：只接受同源 Cookie，请求带了 Authorization 头或查询串令牌反而直接拒绝，失败在建流之前就以普通 HTTP 响应返回。两个守卫都把「上游不可达」与「令牌无效」区分开，分别回 503 和 401 的错误信封。

## 上下游

被谁使用：`modules/capability/routes.ts`、`modules/session/routes.ts`、`modules/artifact/routes.ts` 三个路由表把这两个守卫挂在各自端点的前置处理链上。

依赖什么：引用 `platform/infra/logto.ts` 与 `platform/infra/dev-session.ts` 做两路验签，引用 `platform/infra/db.ts` 的句柄类型并直接查数据库的 users 表，引用 `platform/http/_helpers.ts` 回错误信封，角色与鉴权上下文的类型来自共享包 @cb/shared。
