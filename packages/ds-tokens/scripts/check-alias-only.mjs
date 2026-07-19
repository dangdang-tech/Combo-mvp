// 语义层纯引用校验：扫描 tokens/semantic.json 与 tokens/motion.json（两者共同构成语义层），
// 每个 token 的 $value 必须是形如 {xx.yy} 的单个引用；若是 light/dark 对象，则每个模式值
// 也必须是单个引用。发现任何裸值即以退出码 1 结束。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PURE_REF_RE = /^\{[^{}]+\}$/;
const MODE_KEYS = new Set(['light', 'dark']);

const violations = [];

function checkValue(file, key, label, value) {
  if (typeof value === 'string') {
    if (!PURE_REF_RE.test(value.trim())) {
      violations.push(`${file} 的 ${key}（${label}）不是纯引用：${value}`);
    }
    return;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [mode, modeValue] of Object.entries(value)) {
      if (!MODE_KEYS.has(mode)) {
        violations.push(`${file} 的 ${key} 含未知模式键：${mode}（只允许 light/dark）`);
        continue;
      }
      checkValue(file, key, mode, modeValue);
    }
    return;
  }
  violations.push(`${file} 的 ${key}（${label}）$value 形态非法：${JSON.stringify(value)}`);
}

for (const file of ['semantic.json', 'motion.json']) {
  const doc = JSON.parse(readFileSync(join(pkgDir, 'tokens', file), 'utf8'));
  for (const [key, def] of Object.entries(doc.semantic ?? {})) {
    checkValue(file, key, '$value', def.$value);
  }
}

if (violations.length > 0) {
  console.error('语义层纯引用校验失败：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('语义层纯引用校验通过：所有 $value 均为 {} 引用。');
