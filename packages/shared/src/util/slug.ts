// 跨域 slug 工具（提取域聚类与结构化建能力体共用，避免域间硬耦合）。
//   取标签的 ASCII 词；纯 CJK/太短退回确定性 hash 后缀，保证 SlugSchema 合法（小写字母数字+连字符）。

/** slug 化：取标签的 ASCII 词；CJK 退回 hash 后缀，保证 SlugSchema 合法（小写字母数字+连字符）。 */
export function slugify(label: string, fallbackSeed: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (ascii.length >= 2) return ascii;
  // 纯 CJK / 太短：用确定性 hash 后缀（同输入同 slug，便于幂等/去重）。
  let h = 0;
  for (const ch of fallbackSeed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `cap-${h.toString(36)}`;
}
