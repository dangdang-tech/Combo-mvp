// 本包是 --cb-* 设计 token 的唯一源头：apps/web 与 apps/runtime-web 已改为在入口 main.tsx 直接
// import '@cb/ds-tokens/tokens.css' 消费构建产物，不再在各自 styles.css 的 :root 里手工自存一份 canon。
// 因此原「canon 对齐」测试（读 apps/web/src/styles.css :root 与 dist 逐值比对）已随 canon 消失而删除。
// 本文件保留两项断言：① 构建幂等（连跑两次 build.mjs，dist 产物哈希一致）；
// ② 两个 app 的入口确实 import 了 @cb/ds-tokens/tokens.css（token 链路没有断开）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgDir, '..', '..');
const distPath = join(pkgDir, 'dist', 'tokens.css');

function runBuild() {
  execFileSync(process.execPath, [join(pkgDir, 'build.mjs')], { cwd: pkgDir, stdio: 'pipe' });
}

describe('ds-tokens 构建与消费链路', () => {
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

  it('两个 app 的入口 main.tsx 都 import 了 @cb/ds-tokens/tokens.css（唯一 token 源头）', () => {
    const entries = [
      join(repoRoot, 'apps', 'web', 'src', 'main.tsx'),
      join(repoRoot, 'apps', 'runtime-web', 'src', 'main.tsx'),
    ];
    for (const entry of entries) {
      const source = readFileSync(entry, 'utf8');
      expect(source, `${entry} 未 import @cb/ds-tokens/tokens.css`).toContain(
        '@cb/ds-tokens/tokens.css',
      );
    }
  });
});
