import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './shell/AppShell.js';
import { AuthGate } from './shell/AuthGate.js';
import { MarketPage } from './pages/MarketPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { CapabilityDeepLink } from './pages/CapabilityDeepLink.js';

export function App() {
  return (
    <AuthGate>
      <BrowserRouter basename="/try">
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/market" replace />} />
            {/* 入口页：能力列表 + 历史会话 */}
            <Route path="market" element={<MarketPage />} />
            {/* 对话页（已存在会话 id；新会话由入口页 POST /runtime/sessions 后跳入） */}
            <Route path="session/:sessionId" element={<ChatPage />} />
            {/* 创作端「去试用」深链：为该能力建会话并转入对话页 */}
            <Route path="c/:capabilityId" element={<CapabilityDeepLink />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthGate>
  );
}
