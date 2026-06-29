// vitest setup（每个测试文件前执行一次）。
//   1. @testing-library/jest-dom：toBeInTheDocument 等 DOM 匹配器。
//   2. afterEach 清理：unmount RTL 渲染 + 复位 MockFetchEventSource 连接表 + 还原 fetch mock。
//
// SSE 测试不再注入全局 EventSource：useSSE 改用 @microsoft/fetch-event-source（Codex r2 P1 #7），
// 测试经 useSSE 导出的 __setFetchEventSourceForTests seam 换受控 MockFetchEventSource（见各测试文件）。
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { MockFetchEventSource } from './mockFetchEventSource.js';

afterEach(() => {
  cleanup();
  MockFetchEventSource.reset();
});
