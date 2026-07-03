// 创作者中心前端路由树（F-04）：分两组——受保护（创作者外壳）+ 公开（裸壳），中间隔一道登录守卫。
//
// 受保护组（RequireAuth → ProtectedLayout 提供真实账号 + Shell）：工作台 / 我的能力 / 数据分析 /
//   收益 / 个人主页（/profile = 「我」的 self 视图）/ 上传五步。守卫在路由层一举堵住 BUG-001/002/003/004/007：
//   未登录直达任何受保护页 → 裸登录闸门（绝非 Wayne 外壳、绝非裸转圈、绝非自动 POST 草稿）。
// 公开组（PublicLayout 裸壳，无侧栏/账号）：公开能力页 /a/:slug、公开创作者主页 /c/:slug、
//   公开只读个人名片 /creators/:creatorId/profile（后端 optionalAuth，匿名可看，绝不挂登录闸门/创作者外壳）、
//   登录页 + 404 兜底，均诚实人话态、无内部文案渗漏、不包创作者外壳（BUG-005/006）。
import type { ReactElement } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { ViewModeProvider } from './shell/viewMode.js';
import { AuthProvider, RequireAuth } from './shell/auth.js';
import { ProtectedLayout } from './shell/ProtectedLayout.js';
import { PublicLayout } from './shell/PublicLayout.js';
import { DashboardPage } from './pages/dashboard/index.js';
import {
  CapabilitiesPage,
  AnalyticsPage,
  RevenuePage,
  ProfilePage,
  PublicCapabilityPage,
  PublicCreatorPage,
  LoginPage,
  NotFoundPage,
  ImportStepPage,
  CapabilitiesStepPage,
} from './pages/index.js';
// 上传向导（F-09 WizardShell + F-15 续传）；PRD 2 步（上传 / 能力页）渲染其 Outlet。
import { WizardLayout } from './pages/wizard/index.js';

/**
 * 受保护组根：把 AuthProvider 下移到这里（只包受保护子树），故只有受保护路由命中时才挂载
 * AuthProvider → 触发 useMe() 请求 GET /api/v1/me。公开 / 登录 / 404 组在它之外，匿名访问
 * 根本不发 /me（消除 BUG-010 的 401 console 噪声）。AuthProvider 经 <Outlet/> 把会话四态
 * 喂给内层 RequireAuth（守卫）与 ProtectedLayout（外壳账号区），鉴权链结构不变。
 */
function ProtectedRoot(): ReactElement {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export function App(): ReactElement {
  return (
    <ViewModeProvider>
      <BrowserRouter>
        <Routes>
          {/* 受保护组：AuthProvider（仅此子树发 /me）→ 守卫放行后才进创作者外壳（真实账号），未登录 → 裸登录闸门。 */}
          <Route element={<ProtectedRoot />}>
            <Route element={<RequireAuth />}>
              <Route element={<ProtectedLayout />}>
                <Route index element={<Navigate to="/creator" replace />} />
                <Route path="/creator" element={<DashboardPage />} />
                <Route path="/capabilities" element={<CapabilitiesPage />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/earnings" element={<RevenuePage />} />
                <Route path="/profile" element={<ProfilePage />} />

                {/* 上传向导（PRD 2 步）：WizardShell（F-09 向导壳，外壳恒定 D14）+ 两子步。
                    上传（ImportStepPage，传完自动进入能力页）+ 能力页（CapabilitiesStepPage：提取过程态 → 候选卡 → 一键发布）。
                    提取过程态不占独立路由，是能力页的一个阶段。在守卫内：未登录此子树不挂载 → 不会自动 POST /drafts（BUG-004）。 */}
                <Route path="/create" element={<WizardLayout />}>
                  <Route index element={<Navigate to="/create/import" replace />} />
                  <Route path="import" element={<ImportStepPage />} />
                  <Route path="capabilities" element={<CapabilitiesStepPage />} />
                </Route>
              </Route>
            </Route>
          </Route>

          {/* 公开组：裸壳（无创作者外壳/侧栏/账号），且在 AuthProvider 之外——匿名访问不发 /me（BUG-010）。
              公开页 + 登录 + 404 都诚实人话、无内部文案渗漏。 */}
          <Route element={<PublicLayout />}>
            {/* 登录页：承接 OIDC 回调失败回跳 /login?failureId=<opaque>（10-auth §3.2）+ 通用登录引导。 */}
            <Route path="/login" element={<LoginPage />} />
            {/* 公开只读个人名片（访客同视图）：/creators/:creatorId/profile（60 §2，后端 optionalAuth）。
                在公开裸壳下：匿名直达拿到公开名片（不挂登录闸门）；ProfilePage 不依赖 Shell context，
                按 URL :creatorId 解析（非 self 'me'），与受保护组的 /profile（self）分流互不影响。 */}
            <Route path="/creators/:creatorId/profile" element={<ProfilePage />} />
            {/* 公开能力页（对外只读）：工作台「查看公开页」/ 作品墙卡片落点 /a/:slug。 */}
            <Route path="/a/:slug" element={<PublicCapabilityPage />} />
            {/* 公开创作者主页（对外只读）：/c/:slug。 */}
            <Route path="/c/:slug" element={<PublicCreatorPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ViewModeProvider>
  );
}
