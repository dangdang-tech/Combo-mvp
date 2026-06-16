// B-21 · 本机助手脚本渲染（20-step1-import §3.2）。
//   GET /import/connect/script 下发的可执行 node 脚本（text/javascript，经 `node -` 跑）。
//   职责（§3.2）：扫 ~/.claude/projects + ~/.codex/sessions → 原文【全量】打包 → 用 node:http/https
//     **分片**直发 POST /api/v1/import/connect/upload?pairId=...&partIndex=N&totalParts=M&contentSha256=...，
//     pairId 走 **query**（PairAuth preHandler 定位行，Codex P0-1）+ Authorization: Bearer <code>。
//   per-part 幂等（Codex P1-5）：每片独立 Idempotency-Key = `pair-{pairId}-{partIndex}-{contentSha256}`，
//     含 partIndex + 内容 hash，分片间绝不互相 replay/冲突；重跑命令时同片同 key 幂等续传。
//   文案口径硬约束（导入-04/05/29）：必须是「在本机读取后【全量上传原文】、云端解析去敏」；
//     绝不出现「数据不出本机 / 仅上传精简 / 原始日志不出本机 / 本机解析只传提取后」等字眼。
//   注入值（base/pairId/pairingCode）由服务端按请求 Host+code 反查填入；脚本对外不裸 JSON 错误码（硬规则②）。

/** 脚本注入参数（服务端据请求算/反查）。 */
export interface ConnectScriptParams {
  base: string; // 形如 https://agora.app
  pairId: string; // 由 ?code 反查，供上传定位 import_pairings 行（Codex#3-r2）
  pairingCode: string; // 一次性配对码（助手凭它换上传权；走 Authorization: Bearer）
}

/** JSON.stringify 注入字符串（防注入闭合脚本字符串）。 */
function lit(s: string): string {
  return JSON.stringify(s);
}

/**
 * 渲染助手脚本（active 配对）。脚本在用户本机跑：读 ~/.claude + ~/.codex 全量 → 上传 → 打印进度人话。
 * 无第三方依赖（仅 node 内置 fs/path/os/http/https），可 `curl ... | node -` 直跑。
 */
export function renderConnectScript(p: ConnectScriptParams): string {
  return `#!/usr/bin/env node
// Agora 本机助手 — 在本机读取你的对话历史后，将原文【完整上传】到云端，由云端解析、抹掉手机号/密钥这类隐私信息后用于后续步骤。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BASE = ${lit(p.base)};
const PAIR_ID = ${lit(p.pairId)};
const PAIRING_CODE = ${lit(p.pairingCode)};
// 单片字节上限（超过则切多片，分片协议；每片独立 per-part 幂等键，Codex P1-5）。
const PART_SIZE = 8 * 1024 * 1024;

function log(msg) { process.stderr.write('[Agora] ' + msg + '\\n'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 递归收集一个目录下的全部 .jsonl 原文（claude/codex 会话日志）。
function collectJsonl(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectJsonl(full));
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function gather() {
  const home = os.homedir();
  const roots = [path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions')];
  let files = [];
  for (const r of roots) files = files.concat(collectJsonl(r));
  return files;
}

// 把原文全量打包成一个流（每个文件原样拼，文件间以一行 JSON 头分隔，便于云端按来源切分）。
function packRaw(files) {
  const chunks = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch (_e) { continue; }
    const source = f.includes('.codex') ? 'codex' : 'claude';
    chunks.push(Buffer.from(JSON.stringify({ __agora_file__: path.basename(f), source }) + '\\n'));
    chunks.push(buf);
    chunks.push(Buffer.from('\\n'));
  }
  return Buffer.concat(chunks);
}

// 把原文切成多片（每片 <= PART_SIZE）。
function splitParts(payload) {
  const parts = [];
  for (let off = 0; off < payload.length; off += PART_SIZE) {
    parts.push(payload.subarray(off, Math.min(off + PART_SIZE, payload.length)));
  }
  return parts.length > 0 ? parts : [Buffer.alloc(0)];
}

// 上传单片：pairId/partIndex/totalParts/contentSha256 走 query（Codex P0-1/P1-5），原文走 multipart 文件域。
function postPart(partBuf, partIndex, totalParts) {
  return new Promise((resolve, reject) => {
    const hash = sha256(partBuf);
    const u = new URL(BASE + '/api/v1/import/connect/upload');
    u.searchParams.set('pairId', PAIR_ID);
    u.searchParams.set('source', 'mixed');
    u.searchParams.set('partIndex', String(partIndex));
    u.searchParams.set('totalParts', String(totalParts));
    u.searchParams.set('contentSha256', hash);
    const boundary = '----agora' + Date.now() + '-' + partIndex;
    const pre = Buffer.from(
      '--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="history-' + partIndex + '.jsonl"\\r\\n' +
      'Content-Type: application/octet-stream\\r\\n\\r\\n'
    );
    const post = Buffer.from('\\r\\n--' + boundary + '--\\r\\n');
    const body = Buffer.concat([pre, partBuf, post]);
    const lib = u.protocol === 'https:' ? https : http;
    // per-part 幂等键：含 partIndex + 内容 hash，分片间互不 replay（Codex P1-5）；重跑同片同 key 幂等。
    const idemKey = 'pair-' + PAIR_ID + '-' + partIndex + '-' + hash;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Authorization': 'Bearer ' + PAIRING_CODE,
          'Idempotency-Key': idemKey,
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  log('正在读取本机对话历史…');
  const files = gather();
  if (files.length === 0) {
    log('没扫到可导入的对话历史。去产生一些历史后再来，或回网页换种导入方式。');
    process.exit(1);
  }
  log('扫到 ' + files.length + ' 个会话文件，正在把原文完整上传到云端（云端会抹掉隐私信息）…');
  const payload = packRaw(files);
  const parts = splitParts(payload);
  try {
    for (let i = 0; i < parts.length; i++) {
      const res = await postPart(parts[i], i, parts.length);
      if (res.status < 200 || res.status >= 300) {
        log('上传没能完成，回网页重新生成连接码后再试。');
        process.exit(1);
      }
      log('已上传 ' + (i + 1) + ' / ' + parts.length + ' 片…');
    }
    log('上传完成，回到网页查看云端解析进度。');
    process.exit(0);
  } catch (_e) {
    log('上传中断了，重跑这条命令即可续传。');
    process.exit(1);
  }
})();
`;
}

/**
 * 渲染「配对失效」脚本片段（码无效/过期；脚本通道不裸 JSON 错误码，硬规则②）。
 * 跑起来只打印一句人话到 stderr 并非零退出，引导回网页重铸。
 */
export function renderExpiredScript(): string {
  return `#!/usr/bin/env node
'use strict';
process.stderr.write('[Agora] 配对码已失效，请回到网页重新生成连接码。\\n');
process.exit(1);
`;
}
