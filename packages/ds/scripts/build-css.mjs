// 把 src 下所有组件 CSS 按路径字典序汇总成 dist/styles.css（构建产物，勿手改），
// 同时把每个组件 CSS 原样复制到 dist 的镜像路径下：tsc 产出的 dist JS 里保留着
// import './button.css' 这类相对引入，dist 里缺少这些文件时任何消费 dist 的包都无法解析模块。
// 字典序保证产物可重复（幂等）；组件样式之间不允许有顺序依赖，发现依赖顺序即组件写法有问题。
import { copyFileSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(pkgRoot, 'src');

function collectCss(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCss(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const files = collectCss(srcDir);
const banner = '/* 由 @cb/ds scripts/build-css.mjs 生成，勿手改。 */\n';
const body = files
  .map((f) => `/* --- ${relative(pkgRoot, f)} --- */\n${readFileSync(f, 'utf8').trim()}\n`)
  .join('\n');
const distDir = join(pkgRoot, 'dist');
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'styles.css'), banner + body);
for (const f of files) {
  const target = join(distDir, relative(srcDir, f));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(f, target);
}
console.log(`dist/styles.css <- ${files.length} 个 CSS 文件（并已镜像复制到 dist 各组件目录）`);
