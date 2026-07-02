import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 生产部署在 authoring 那台 nginx 的 /try/ 子路径下（复用 8080）；资源路径据此加前缀。
  base: '/try/',
  server: {
    port: 5174,
    // 远程体验：绑 0.0.0.0 + 放开 Host 校验，SSH 转发 / 直连 IP / 隧道 三种打开方式都能用（仅本地/内网测试用）。
    host: true,
    allowedHosts: true,
    proxy: {
      // dev：runtime API 走 3100；登录态和 /me 复用 authoring API 3000。
      '/api/v1/runtime': 'http://localhost:3100',
      '/api/v1/client-events': 'http://localhost:3000',
      '/api/v1/auth': 'http://localhost:3000',
      '/api/v1/me': 'http://localhost:3000',
      '/healthz': 'http://localhost:3100',
      '/readyz': 'http://localhost:3100',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
