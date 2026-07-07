// Combo 设计 token 构建脚本：读取 tokens/ 下的 DTCG JSON，解析全部 {} 引用与 light/dark
// 双模式取值，再经 style-dictionary v4 输出 dist/tokens.css 与 dist/tokens.flat.json。
// 语义 token 的 CSS 变量名规则固定为「--cb- 加语义 key」，例如 semantic.paper 输出 --cb-paper。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import StyleDictionary from 'style-dictionary';

const pkgDir = dirname(fileURLToPath(import.meta.url));
const readTokens = (file) => JSON.parse(readFileSync(join(pkgDir, 'tokens', file), 'utf8'));

const primitives = readTokens('primitives.json');
const semanticFile = readTokens('semantic.json');
const motionFile = readTokens('motion.json');

// 语义层 = semantic.json 与 motion.json 两份文件合并（motion.json 是语义层的动效部分）。
const semantic = { ...semanticFile.semantic, ...motionFile.semantic };
const tree = { ...primitives, semantic };

const REF_RE = /\{([^{}]+)\}/g;

function lookup(path) {
  let node = tree;
  for (const part of path.split('.')) {
    node = node === undefined || node === null ? undefined : node[part];
  }
  if (node === undefined || node === null || node.$value === undefined) {
    throw new Error(`token 引用不存在：{${path}}`);
  }
  return node;
}

// $value 若是 { light, dark } 对象则按模式取值，否则原样返回（模式无关 token）。
function pickMode(value, mode) {
  if (value !== null && typeof value === 'object') {
    return value[mode] ?? value.light;
  }
  return value;
}

// 解析一个 $value 里的全部 {} 引用。
// inlineSemantic 为 false 时，指向语义层的引用输出成 var(--cb-*)（CSS 产物用）；
// 为 true 时递归内联到最终字面值（tokens.flat.json 用）。
function resolveValue(rawValue, mode, inlineSemantic, stack = []) {
  const value = pickMode(rawValue, mode);
  if (typeof value !== 'string') {
    throw new Error(
      `token $value 必须是字符串或 light/dark 对象，实际拿到：${JSON.stringify(value)}`,
    );
  }
  return value.replace(REF_RE, (_whole, refPath) => {
    if (stack.includes(refPath)) {
      throw new Error(`token 引用成环：${[...stack, refPath].join(' 引用 ')}`);
    }
    const nextStack = [...stack, refPath];
    if (refPath.startsWith('semantic.') && !inlineSemantic) {
      const key = refPath.slice('semantic.'.length);
      if (!semantic[key]) throw new Error(`语义 token 不存在：{${refPath}}`);
      return `var(--cb-${key})`;
    }
    return resolveValue(lookup(refPath).$value, mode, inlineSemantic, nextStack);
  });
}

// 逐个语义 token 解析出 light 输出、dark 输出与完全内联的 light 字面值。
const entries = Object.keys(semantic).map((key) => {
  const def = semantic[key];
  const light = resolveValue(def.$value, 'light', false);
  const dark = resolveValue(def.$value, 'dark', false);
  const flat = resolveValue(def.$value, 'light', true);
  return { key, type: def.$type, light, dark, flat };
});

const HEADER = [
  '/* 生成物勿手改。',
  ' * 本文件由 packages/ds-tokens/build.mjs 从 tokens/primitives.json、tokens/semantic.json、',
  ' * tokens/motion.json 构建生成；修改 token 请改源 JSON 后重新执行 pnpm -F @cb/ds-tokens build。 */',
].join('\n');

const lightLines = entries.map((e) => `  --cb-${e.key}: ${e.light};`);
const darkLines = entries
  .filter((e) => e.dark !== e.light)
  .map((e) => `  --cb-${e.key}: ${e.dark};`);

const cssText = [
  HEADER,
  '',
  ':root {',
  ...lightLines,
  '}',
  '',
  "[data-cb-theme='dark'] {",
  ...darkLines,
  '}',
  '',
].join('\n');

const flatMap = {
  $comment: '生成物勿手改：由 packages/ds-tokens/build.mjs 生成（light 模式，完全内联）。',
};
for (const e of entries) {
  flatMap[`--cb-${e.key}`] = e.flat;
}
const flatText = `${JSON.stringify(flatMap, null, 2)}\n`;

// 交给 style-dictionary 的 token 树：全部引用与模式都已解析，dark 差异值挂在 $extensions 上。
const resolvedTokens = { semantic: {} };
for (const e of entries) {
  resolvedTokens.semantic[e.key] = {
    $type: e.type,
    $value: e.light,
    $extensions: { 'cb.dark': e.dark, 'cb.flat': e.flat },
  };
}

StyleDictionary.registerFormat({ name: 'cb/css-variables', format: () => cssText });
StyleDictionary.registerFormat({ name: 'cb/flat-json', format: () => flatText });

const sd = new StyleDictionary({
  tokens: resolvedTokens,
  platforms: {
    css: {
      buildPath: `${join(pkgDir, 'dist')}/`,
      files: [
        { destination: 'tokens.css', format: 'cb/css-variables' },
        { destination: 'tokens.flat.json', format: 'cb/flat-json' },
      ],
    },
  },
});

await sd.buildAllPlatforms();
console.log(
  `ds-tokens 构建完成：light ${lightLines.length} 个变量，dark 差异 ${darkLines.length} 个变量。`,
);
