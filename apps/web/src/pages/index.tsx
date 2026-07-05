// 公开组页面（裸壳 PublicLayout 内渲染）：登录页 + 404。业务两页在 pages/tasks、pages/capabilities。
import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AUTH_LOGIN_PATH } from '../shell/auth.js';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';

export { TasksPage } from './tasks/TasksPage.js';
export { TaskDetailPage } from './tasks/TaskDetailPage.js';
export { CapabilitiesPage } from './capabilities/CapabilitiesPage.js';

// 登录页 /login——承接登录失败回跳 /login?failureId=<opaque>。据 opaque failureId 渲染人话失败态
// （绝不透传内部 code / OIDC 原始报错），给「去登录」重试退路；无 failureId 则普通登录引导。
// failureId 仅作「反馈代码」供报障关联，非错误码。
export function LoginPage(): ReactElement {
  const [params] = useSearchParams();
  const failureId = params.get('failureId');
  const failed = failureId != null && failureId.length > 0;
  useDocumentTitle('登录 · Combo');
  return (
    <section className="cb-page cb-public" aria-labelledby="cb-login-title">
      <div className="cb-public__notice">
        <h2 className="cb-public__title" id="cb-login-title">
          {failed ? '登录没能完成' : '登录后进入创作者中心'}
        </h2>
        <p className="cb-public__lead">
          {failed
            ? '这次登录没能完成，请重新登录。如果多次失败，可凭下方反馈代码联系我们。'
            : '请登录后管理你的上传任务与能力。'}
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

// 人话 404：给回首页 + 去登录两条退路，无内部文案渗漏。
export function NotFoundPage(): ReactElement {
  useDocumentTitle('页面不存在 · Combo');
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
