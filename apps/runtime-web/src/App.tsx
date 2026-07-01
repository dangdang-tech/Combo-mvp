import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './shell/AppShell.js';
import { MarketPage } from './pages/MarketPage.js';
import { ChatPage } from './pages/ChatPage.js';

export function App() {
  return (
    <BrowserRouter basename="/try">
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<MarketPage />} />
          {/* 新建会话（按能力 slug 起一局）；路由名用 c 避免 basename=/try 下出现 /try/try */}
          <Route path="c/:slug" element={<ChatPage />} />
          {/* 续话（已存在会话 id） */}
          <Route path="session/:sessionId" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
