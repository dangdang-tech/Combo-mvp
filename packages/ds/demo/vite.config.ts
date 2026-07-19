// demo 画廊的 Vite 配置：构建根目录固定为本目录（demo/），
// 开发服务器放开到仓库根目录，保证能读取 ../src 源码与 workspace 链接的 @cb/ds-tokens 产物。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, '../../..');

export default defineConfig({
  root: demoDir,
  plugins: [react()],
  cacheDir: resolve(demoDir, '../node_modules/.vite-demo'),
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    outDir: resolve(demoDir, 'dist'),
    emptyOutDir: true,
  },
});
