// 双模式齐备校验：扫描语义层（tokens/semantic.json 与 tokens/motion.json），确保每个
// color 语义 token 在 light 和 dark 两个模式下都有值。$value 是单个引用字符串的 token
// 视为模式无关（别名与 color-mix 配方在两个模式下输出相同的 var() 表达式，天然双模式
// 齐备）；$value 是对象的 token 必须同时给出 light 与 dark。light/dark 差集非空即以
// 退出码 1 结束。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const hasLight = new Set();
const hasDark = new Set();
const colorKeys = new Set();

for (const file of ['semantic.json', 'motion.json']) {
  const doc = JSON.parse(readFileSync(join(pkgDir, 'tokens', file), 'utf8'));
  for (const [key, def] of Object.entries(doc.semantic ?? {})) {
    const value = def.$value;
    if (def.$type === 'color') colorKeys.add(key);
    if (typeof value === 'string') {
      // 模式无关 token：两个模式下都解析为同一个值。
      hasLight.add(key);
      hasDark.add(key);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      if (typeof value.light === 'string' && value.light.length > 0) hasLight.add(key);
      if (typeof value.dark === 'string' && value.dark.length > 0) hasDark.add(key);
    }
  }
}

const missingDark = [...hasLight].filter((k) => !hasDark.has(k));
const missingLight = [...hasDark].filter((k) => !hasLight.has(k));
const colorUncovered = [...colorKeys].filter((k) => !hasLight.has(k) || !hasDark.has(k));
const problems = [
  ...missingDark.map((k) => `${k} 缺 dark 值`),
  ...missingLight.map((k) => `${k} 缺 light 值`),
  ...colorUncovered.filter((k) => !missingDark.includes(k) && !missingLight.includes(k)),
];

if (problems.length > 0) {
  console.error('双模式齐备校验失败（light/dark 差集非空）：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`双模式齐备校验通过：${colorKeys.size} 个 color 语义 token 均覆盖 light 与 dark。`);
