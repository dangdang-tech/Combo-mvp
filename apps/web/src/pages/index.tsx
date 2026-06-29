// 占位页集合（Phase 4 各自拆成独立文件 + 真实实现）。每页标注对接的后端契约端点。
//
// 五步上传向导壳 + STEP③ 已由 pages/wizard/ 实现（WizardLayout/WizardShell/SelectStepPage）：
//   /create 路由元素改用 WizardLayout（替代旧 CreateLayout 步骤条占位），STEP③ 用 wizard 的 SelectStepPage。
//   本文件保留 STEP①②④⑤ 占位页（后续模块填），它们渲染在 WizardShell 的 <Outlet> 内（外壳恒定 D14）。
import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Placeholder } from './Placeholder.js';
import { AUTH_LOGIN_PATH } from '../shell/auth.js';

// F-07 三页真实实现（我的能力 / 数据分析 / 收益）——各自独立文件 + 组件测试。
export { CapabilitiesPage } from './capabilities/CapabilitiesPage.js';
export { AnalyticsPage } from './analytics/AnalyticsPage.js';
export { RevenuePage } from './revenue/RevenuePage.js';

// F-06 个人主页真实实现（六分区主聚合）——独立目录 + 组件测试。
export { ProfilePage } from './profile/index.js';

// 公开能力页 /a/:slug + 公开创作者主页 /c/:slug（对外只读，裸壳 PublicLayout，无创作者外壳）。
export { PublicCapabilityPage } from './public/PublicCapabilityPage.js';
export { PublicCreatorPage } from './public/PublicCreatorPage.js';

// F-10 STEP① 导入 + F-11 STEP② 提取 + F-13 STEP④ 结构化 + F-14 STEP⑤ 发布真实实现（接 3B/3C/3D/3E API+SSE，在 WizardShell 内）。
export {
  ImportStepPage,
  ExtractStepPage,
  StructureStepPage,
  PublishStepPage,
} from './upload/index.js';

export function WorkbenchPage(): ReactElement {
  return (
    <Placeholder
      title="工作台"
      hint="对接 GET /dashboard/summary · /metrics · /token-trend · /capabilities · /drafts"
    />
  );
}

// 真实人话 404（裸壳 PublicLayout 内渲染）——不再包 Placeholder 开发脚手架，绝不渗漏
// 「Phase X 实现」/ 内部契约前缀（BUG-006）。给回首页 + 去登录两条退路。
export function NotFoundPage(): ReactElement {
  return (
    <section className="cb-page cb-public" aria-labelledby="cb-notfound-title">
      <div className="cb-public__notice">
        <h2 className="cb-public__title" id="cb-notfound-title">
          页面不存在或已失效
        </h2>
        <p className="cb-public__lead">你访问的链接可能已变更或不再可用。</p>
        <div className="cb-public__actions">
          <Link to="/" className="cb-public__action">
            回到首页
          </Link>
          <a href={AUTH_LOGIN_PATH} className="cb-public__action cb-public__action--ghost">
            去登录
          </a>
        </div>
      </div>
    </section>
  );
}

// 登录页 /login（裸壳 PublicLayout 内）——承接登录失败回跳 /login?failureId=<opaque>（10-auth §3.2）。
// 据 opaque failureId 渲染人话登录失败态（绝不透传内部 code / OIDC 原始报错 / 堆栈），给「去登录」重试退路；
// 无 failureId（直接访问 /login）则普通登录引导。failureId 仅作「反馈代码」供报障关联，非错误码（BUG-007）。
export function LoginPage(): ReactElement {
  const [params] = useSearchParams();
  const failureId = params.get('failureId');
  const failed = failureId != null && failureId.length > 0;
  return (
    <section className="cb-page cb-public" aria-labelledby="cb-login-title">
      <div className="cb-public__notice">
        <h2 className="cb-public__title" id="cb-login-title">
          {failed ? '登录没能完成' : '登录后进入创作者中心'}
        </h2>
        <p className="cb-public__lead">
          {failed
            ? '这次登录没能完成，请重新登录。如果多次失败，可凭下方反馈代码联系我们。'
            : '请登录后查看你的工作台、能力与个人主页。'}
        </p>
        <div className="cb-public__actions">
          <a href={AUTH_LOGIN_PATH} className="cb-public__action">
            去登录
          </a>
          <Link to="/" className="cb-public__action cb-public__action--ghost">
            回到首页
          </Link>
        </div>
        {failed && <p className="cb-public__feedback">反馈代码：{failureId}</p>}
      </div>
    </section>
  );
}

// STEP①②④⑤ 由 pages/upload 实现（F-10/F-11/F-13/F-14，接 3B/3C/3D/3E API+SSE，在 WizardShell 内）。
// STEP③ 选择由 pages/wizard/SelectStepPage 实现（F-12，纯前端即时态 + 存草稿 PATCH /drafts/{id}/selection）。
