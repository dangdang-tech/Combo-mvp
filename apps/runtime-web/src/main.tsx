// 设计系统样式按 token → 组件 → 本 app 顺序注入：先 @cb/ds-tokens 的 --cb-* 变量（唯一源头），
// 再 @cb/ds 组件样式，最后本 app 的 styles.css，保证层叠里 app 样式可覆盖组件默认。
import '@cb/ds-tokens/tokens.css';
import '@cb/ds/styles.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { installGlobalClientErrorHandlers } from './api/telemetry.js';

installGlobalClientErrorHandlers();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
