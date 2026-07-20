# Combo × Logto 登录体验

此目录把托管在 Logto 的登录、注册和认证恢复页面纳入仓库审计。主题取自
`apps/web/src/design-claude.css` 的 warm editorial 设计语言，而不是复制 Logto Console 中
不可追踪的手工样式。

## 文件

- `combo-sign-in.css`：Logto Custom CSS。只使用 `class*` / `class$` 的语义片段匹配 CSS
  Modules，不依赖构建生成的完整类名。
- `scripts/publish-logto-branding.mjs`：校验主题或通过 Logto Management API 发布。
- `.github/workflows/logto-branding.yml`：有管理凭据后可手动发布到生产环境。

主题覆盖登录、注册、忘记密码和 MFA 等同一 Sign-in Experience 下的页面；不会隐藏 Logto
开发租户提示。橙色“开发模式”提示只能通过使用 Production tenant 消除，不应以 CSS 伪装。

## 本地校验

```bash
pnpm logto:validate
pnpm test:logto
```

校验是默认行为，不读管理密钥，也不产生网络请求。输出仅包含 CSS 大小、SHA-256 和待更新
字段，不会打印 secret 或 access token。

## 发布

先在 Logto Console 创建 **Machine-to-Machine** 应用，并仅授予更新 Sign-in Experience 所需的
Management API 权限。不要复用 Web 应用的 `LOGTO_APP_SECRET`。

```bash
export LOGTO_ENDPOINT='https://<tenant>.logto.app'
export LOGTO_MANAGEMENT_APP_ID='...'
export LOGTO_MANAGEMENT_APP_SECRET='...'
pnpm logto:publish
```

发布脚本使用 `client_credentials` 获取面向 `https://default.logto.app/api` 的短期 token，然后
`PATCH /api/sign-in-exp`。它只更新以下字段：

- `color`
- `branding`（仅在提供可选 URL 时）
- `hideLogtoBranding`
- `customCss`

发布脚本不会修改登录方式、注册方式或语言检测策略；`PATCH` 成功后还会逐项核对返回的 CSS、
颜色和品牌字段，响应不完整或仍为旧值时直接失败，不报告假成功。

为避免管理密钥因变量误配被发送到第三方主机，生产发布只允许源码中登记的
`andkzt.logto.app`。迁移租户或启用新的认证域名时，必须通过代码审查更新允许列表。

可选品牌图片变量均必须是 HTTPS：

- `LOGTO_BRANDING_LOGO_URL`
- `LOGTO_BRANDING_DARK_LOGO_URL`
- `LOGTO_BRANDING_FAVICON_URL`
- `LOGTO_BRANDING_DARK_FAVICON_URL`

当前字标由 CSS 在 `logto_branding-header` 中生成，因此不配置图片也可使用。发布后必须在真实
Logto 登录与注册页面分别做桌面端、移动端验收，并保留 Before / After 截图；仅本地 dry-run
通过不代表线上已生效。

## GitHub 手动发布

Repository environment `production` 需要配置：

- Deployment branches and tags：只允许受保护分支 `main`
- Protection rules：至少配置一名 required reviewer，并禁止管理员绕过（若仓库计划支持）
- Variables: `LOGTO_ENDPOINT`；可选的四个 `LOGTO_BRANDING_*_URL`
- Secrets: `LOGTO_MANAGEMENT_APP_ID`、`LOGTO_MANAGEMENT_APP_SECRET`

工作流自身也只接受 `main` ref，并固定检出 `main`；environment 的分支策略是防止未审分支读取
生产密钥的最终边界，不能省略。未配置这些管理凭据时不要触发工作流。工作流不会创建或提升
Logto 角色。
