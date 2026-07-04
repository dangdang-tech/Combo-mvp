// 配对码纯函数：生成 / 哈希 / 过期时刻。
// 独立成文件是因为建任务（service）与助手上传（pairing）都要用，且 pairing 依赖 service.transition——
// 收在这里避免两者互相 import。
import { createHash, randomInt } from 'node:crypto';

/** 配对码有效期：48 小时。 */
export const PAIRING_TTL_MS = 48 * 60 * 60 * 1000;

/** 码字母表：大写字母 + 数字，去掉易混淆的 0/O/1/I。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * 生成配对码（XXXX-XXXX）。crypto.randomInt（CSPRNG，非 Math.random）；
 * 明文只随建任务响应返一次，库里只存哈希。
 */
export function generatePairingCode(): string {
  const pick = (): string => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]!;
  const quad = (): string => pick() + pick() + pick() + pick();
  return `${quad()}-${quad()}`;
}

/** 配对码哈希（sha256 hex）。归一大小写与首尾空白，助手侧抄码的大小写差异不致命。 */
export function hashPairingCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex');
}

/** 从现在起算的配对码过期时刻（ISO）。 */
export function pairingExpiresAt(now = Date.now()): string {
  return new Date(now + PAIRING_TTL_MS).toISOString();
}
