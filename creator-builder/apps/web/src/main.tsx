import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api/index.js';
import { App } from './App.js';
import './styles.css';

// 默认查询重试策略（BUG-002 直接修复）：不可重试错误（401/escalate，retriable=false）立刻停，
// 绝不空转 ~7s 把骨架挂着；其余瞬时错误最多重试 2 次。永不裸转圈在数据层兑现。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, err) =>
        err instanceof ApiError && !err.retriable ? false : failureCount < 2,
    },
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
