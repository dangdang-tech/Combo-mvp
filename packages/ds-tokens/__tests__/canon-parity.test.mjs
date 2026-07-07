// canon 对齐测试：apps/web/src/styles.css 的 :root 是既成品牌 canon，本包的构建产物
// dist/tokens.css 必须逐变量、逐值与其一致（空白归一后比较；var() 与 color-mix() 原样保留）。
// 另有幂等测试：连跑两次 build.mjs，两次 dist/tokens.css 的内容哈希必须一致。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgDir, '..', '..');
const canonPath = join(repoRoot, 'apps', 'web', 'src', 'styles.css');
const distPath = join(pkgDir, 'dist', 'tokens.css');

function runBuild() {
  execFileSync(process.execPath, [join(pkgDir, 'build.mjs')], { cwd: pkgDir, stdio: 'pipe' });
}

// 取第一个 :root 规则的声明块（canon 与产物的 :root 块内都没有嵌套花括号）。
function extractRootBlock(css) {
  const start = css.indexOf(':root');
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (start === -1 || open === -1 || close === -1) {
    throw new Error('没有找到 :root 块');
  }
  return css.slice(open + 1, close);
}

// 解析声明块为「变量名到空白归一后值」的映射。
function parseDeclarations(block) {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const map = new Map();
  for (const chunk of withoutComments.split(';')) {
    const match = chunk.match(/(--cb-[\w-]+)\s*:\s*([\s\S]+)/);
    if (match) {
      map.set(match[1], match[2].replace(/\s+/g, ' ').trim());
    }
  }
  return map;
}

describe('canon 对齐', () => {
  beforeAll(() => {
    runBuild();
  });

  it('canon :root 里每一个 --cb-* 变量都在 dist/tokens.css 的 :root 中且值完全一致', () => {
    const canonMap = parseDeclarations(extractRootBlock(readFileSync(canonPath, 'utf8')));
    const distMap = parseDeclarations(extractRootBlock(readFileSync(distPath, 'utf8')));
    expect(canonMap.size).toBeGreaterThan(0);
    for (const [name, value] of canonMap) {
      expect(distMap.has(name), `产物缺少 canon 变量 ${name}`).toBe(true);
      expect(distMap.get(name), `变量 ${name} 的值漂移`).toBe(value);
    }
  });

  it('连跑两次 build，dist 全部产物（tokens.css + tokens.flat.json）哈希一致（幂等）', () => {
    const flatPath = distPath.replace('tokens.css', 'tokens.flat.json');
    runBuild();
    const first = createHash('sha256')
      .update(readFileSync(distPath))
      .update(readFileSync(flatPath))
      .digest('hex');
    runBuild();
    const second = createHash('sha256')
      .update(readFileSync(distPath))
      .update(readFileSync(flatPath))
      .digest('hex');
    expect(second).toBe(first);
  });
});
