// token 纯度执法：扫描组件源码，发现裸色值 / 魔法 px 就以非零码退出（接在 build 里，CI 强制）。
// 规则：CSS 里禁止 hex 颜色、rgb()/hsl() 字面量、除 1px 之外的 px 值；TSX 里禁止 hex 颜色。
// 豁免：行内含「purity-ok:」标记（必须跟一句理由）的行跳过；stories/test 文件整体跳过（演示布局用的内联尺寸不属于产品样式）。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgRoot, '..', '..');
const scanRoots = [join(pkgRoot, 'src'), join(repoRoot, 'packages', 'miniapp-renderer', 'src')];

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN = /\b(?:rgb|hsl)a?\(/;
const PX = /\b(\d+(?:\.\d+)?)px\b/g;

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(css|tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const root of scanRoots) {
  for (const file of collect(root)) {
    if (/\.(stories|test)\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
    const isCss = file.endsWith('.css');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes('purity-ok:')) return;
      const trimmed = line.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      const loc = `${relative(repoRoot, file)}:${i + 1}`;
      if (HEX.test(line)) violations.push(`${loc} 裸 hex 颜色：${trimmed}`);
      if (isCss && COLOR_FN.test(line)) violations.push(`${loc} rgb()/hsl() 字面量：${trimmed}`);
      if (isCss) {
        for (const m of line.matchAll(PX)) {
          if (m[1] !== '1') violations.push(`${loc} 魔法 px 值 ${m[0]}：${trimmed}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`token 纯度检查失败，共 ${violations.length} 条：`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('token 纯度检查通过（无裸色值 / 魔法 px）。');
