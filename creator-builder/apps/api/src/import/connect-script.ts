// B-21 · 本机助手脚本渲染（20-step1-import §3.2）。
//   GET /import/connect/script 下发的可执行 shell 脚本（text/x-shellscript，经 `sh` 跑）。
//   执行器 sh + curl（命令行优先方案）：去掉 Node 依赖、走系统代理、可重试、可并发。
//   打包上传（用户实测 7370 文件「一文件一请求」太慢）：把成百上千个 .jsonl 按【整文件】拼进少数几个
//     ≤8MiB 分片（每片 = sentinel 行 + 文件原文，反复拼接），再并发上传这几十个分片。请求数从 N 文件降到
//     ceil(总字节/8MiB) 个分片；服务端分片清单也不再随文件数 O(n²)。worker 端用 splitBundlePart 按 sentinel
//     拆回每个文件再逐个当一会话解析（session-parse.ts），分段口径不变。
//     只切「整文件」不跨片切单文件 → 每片永远是合法 UTF-8 文本，worker getObjectText 直接读，无多字节边界问题。
//   分片协议：每片 curl multipart 直发 POST /import/connect/upload；pairId/partIndex/totalParts/contentSha256 走 query
//     （Codex P0-1），原文走 multipart 文件域 file，鉴权 Authorization: Bearer <code>；
//     per-part Idempotency-Key = pair-{pairId}-{partIndex}-{sha}（Codex P1-5）。打包标记由服务端 createImportJobForPairing
//     固化进 subject_ref（助手路径恒打包），worker 据此走拆包分支。
//   并发：后台任务 + 分批 wait 的可移植并发池（兼容 macOS bash 3.2 / dash，不依赖 `wait -n`）。默认 8 路，AGORA_JOBS 可覆盖。
//   健壮性（用户实测命中）：
//     1) 所有 shell 变量用 ${VAR} 大括号包裹（裸 $VAR 紧跟中文标点在 macOS bash+某些 locale 会把多字节并进变量名 + set -u 崩）。
//     2) 上传 curl -L --location-trusted --post301 --post302（BASE 万一是 http、命中 80→443 跳转仍带 Authorization 重发 POST）。
//     3) 失败把服务端返回体摘要打出来，便于定位。
//   文案口径硬约束（导入-04/05/29）：必须是「在本机读取后【全量上传原文】、云端解析去敏」；
//     绝不出现「数据不出本机 / 仅上传精简 / 原始日志不出本机 / 本机解析只传提取后」等字眼。
import { BUNDLE_SENTINEL } from './session-parse.js';

/** 脚本注入参数（服务端据请求算/反查）。 */
export interface ConnectScriptParams {
  base: string; // 形如 https://agora.app
  pairId: string; // 由 ?code 反查，供上传定位 import_pairings 行（Codex#3-r2）
  pairingCode: string; // 一次性配对码（助手凭它换上传权；走 Authorization: Bearer）
}

/** POSIX shell 单引号安全注入（' → '\''，防注入闭合脚本字符串）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 渲染助手脚本（active 配对）。脚本在用户本机跑：读 ~/.claude/projects + ~/.codex/sessions 全量原文 →
 *   按整文件打包成少数分片 → 并发上传 → 打印进度。纯 POSIX sh + curl，无需 Node，可 `curl ... | sh` 直跑。
 */
export function renderConnectScript(p: ConnectScriptParams): string {
  return `#!/bin/sh
# Agora 本机助手 — 在本机读取你的对话历史后，把原文【完整上传】到云端，由云端解析、抹掉手机号/密钥这类隐私信息后用于后续步骤。
set -u

BASE=${shq(p.base)}
PAIR_ID=${shq(p.pairId)}
CODE=${shq(p.pairingCode)}
SOURCE='mixed'
SENTINEL=${shq(BUNDLE_SENTINEL)}
# 单分片【未压缩】字节上限（按整文件累加到此即另起一片，随后 gzip 压缩再传）。
#   16MiB 未压缩 → gzip 后通常 1-2MB，远低于反代 32m 上限；文本压缩率高，传输量大幅下降。
PART_MAX=16777216
# 并发上传路数（默认 8；想更快可 AGORA_JOBS=16 覆盖）。
MAXJOBS=\${AGORA_JOBS:-8}

log() { printf '[Agora] %s\\n' "$1" >&2; }

# 0. 没有 curl / gzip 就用不了命令行方式（Windows / 极简环境）——给人话出口，引导回网页。
if ! command -v curl >/dev/null 2>&1; then
  log '这台电脑没有 curl，命令行方式用不了。请回到网页，改用浏览器上传。'
  exit 1
fi
if ! command -v gzip >/dev/null 2>&1; then
  log '这台电脑没有 gzip，命令行方式用不了。请回到网页，改用浏览器上传。'
  exit 1
fi

# 算单文件 sha256（per-part 幂等键 + 完整性）。三种工具任取其一；都没有则留空（幂等键仍按 partIndex 唯一）。
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}'
  else
    printf ''
  fi
}

HOME_DIR=\${HOME:-}
if [ -z "\${HOME_DIR}" ]; then HOME_DIR=$(cd ~ 2>/dev/null && pwd); fi

LIST=$(mktemp 2>/dev/null) || LIST="/tmp/agora-import-$$.list"
TMPD=$(mktemp -d 2>/dev/null) || { TMPD="/tmp/agora-import-$$.d"; mkdir -p "\${TMPD}"; }
PARTS_DIR="\${TMPD}/parts"
FAILFLAG="\${TMPD}/failed"
mkdir -p "\${PARTS_DIR}"
: > "\${LIST}"
trap 'rm -rf "\${LIST}" "\${TMPD}"' EXIT INT TERM HUP

UPLOAD_URL="\${BASE}/api/v1/import/connect/upload"

log '正在查找本机对话历史…'
# 一个 .jsonl 文件 = 一个会话；只收非空文件（-size +0c）。
for ROOT in "\${HOME_DIR}/.claude/projects" "\${HOME_DIR}/.codex/sessions"; do
  [ -d "\${ROOT}" ] || continue
  find "\${ROOT}" -type f -name '*.jsonl' -size +0c 2>/dev/null >> "\${LIST}"
done

TOTAL=$(wc -l < "\${LIST}" | tr -d ' ')
if [ -z "\${TOTAL}" ] || [ "\${TOTAL}" = '0' ]; then
  log '没扫到可导入的对话历史。去产生一些历史后再来，或回网页换种导入方式。'
  exit 1
fi

# 打包：把整文件按 sentinel 拼进当前分片，未压缩到 PART_MAX 就 gzip 成 part-N.gz 并另起一片
#   （只切整文件，不跨片切单文件 → 解压后每片仍是合法 UTF-8）。每 500 个会话报一次打包进度，避免长时间静默。
CUR="\${PARTS_DIR}/cur"
: > "\${CUR}"
PART=0
HAVE=0
CNT=0
flush_part() { gzip -c "\${CUR}" > "\${PARTS_DIR}/part-\${PART}.gz"; : > "\${CUR}"; }
while IFS= read -r FILE; do
  [ -n "\${FILE}" ] || continue
  { printf '%s\\n' "\${SENTINEL}"; cat "\${FILE}" 2>/dev/null; printf '\\n'; } >> "\${CUR}"
  HAVE=1
  CNT=$((CNT + 1))
  if [ $((CNT % 500)) -eq 0 ]; then log "正在打包… 已处理 \${CNT} / \${TOTAL} 个会话"; fi
  if [ "$(wc -c < "\${CUR}")" -ge "\${PART_MAX}" ]; then
    flush_part
    PART=$((PART + 1))
    HAVE=0
  fi
done < "\${LIST}"
if [ "\${HAVE}" -eq 1 ]; then flush_part; NPARTS=$((PART + 1)); else NPARTS=\${PART}; fi
if [ "\${NPARTS}" -eq 0 ]; then
  log '没扫到可导入的对话历史。去产生一些历史后再来，或回网页换种导入方式。'
  exit 1
fi

log "打包成 \${NPARTS} 个分片，正在并发上传到云端（\${MAXJOBS} 路并发，云端会抹掉隐私信息）…"

# 上传单个分片（后台并发调用）：失败重试 3 轮，仍失败把「状态码 + 返回体摘要」追加到 FAILFLAG。
upload_one() {
  idx=$1
  pf="\${PARTS_DIR}/part-\${idx}.gz"
  sha=$(sha256_of "\${pf}")
  idem="pair-\${PAIR_ID}-\${idx}-\${sha}"
  url="\${UPLOAD_URL}?pairId=\${PAIR_ID}&source=\${SOURCE}&partIndex=\${idx}&totalParts=\${NPARTS}&contentSha256=\${sha}"
  resp="\${TMPD}/\${idx}.resp"
  attempt=0
  http=000
  while [ "\${attempt}" -lt 3 ]; do
    attempt=$((attempt + 1))
    # --noproxy '*'：上传直连云端、不走系统/公司代理（按需求 3，避免代理拖慢或干扰）。
    http=$(curl -sS -o "\${resp}" -w '%{http_code}' \\
      --noproxy '*' \\
      -L --location-trusted --post301 --post302 \\
      --retry 2 --retry-delay 1 --max-time 600 \\
      -X POST \\
      -H "Authorization: Bearer \${CODE}" \\
      -H "Idempotency-Key: \${idem}" \\
      -F "file=@\${pf}" \\
      "\${url}" </dev/null 2>/dev/null) || http=000
    case "\${http}" in
      2??) rm -f "\${resp}"; return 0 ;;
      *) sleep "\${attempt}" ;;
    esac
  done
  detail=$(head -c 300 "\${resp}" 2>/dev/null | tr '\\n' ' ')
  printf '%s %s\\n' "\${http}" "\${detail}" >> "\${FAILFLAG}"
  rm -f "\${resp}"
  return 1
}

# 并发池：每凑够 MAXJOBS 个后台任务就 wait 一批（可移植，不依赖 wait -n）；任一批出错即停。
IDX=0
PENDING=0
while [ "\${IDX}" -lt "\${NPARTS}" ]; do
  upload_one "\${IDX}" &
  IDX=$((IDX + 1))
  PENDING=$((PENDING + 1))
  if [ "\${PENDING}" -ge "\${MAXJOBS}" ]; then
    wait
    PENDING=0
    if [ -s "\${FAILFLAG}" ]; then break; fi
    log "已上传 \${IDX} / \${NPARTS} 个分片 …"
  fi
done
wait

if [ -s "\${FAILFLAG}" ]; then
  MSG=$(head -1 "\${FAILFLAG}" 2>/dev/null)
  log "上传没能完成（服务返回 \${MSG}）。可回到网页重新生成命令后再试。"
  exit 1
fi

log "已上传 \${NPARTS} / \${NPARTS} 个分片 …"
log '上传完成，回到网页查看云端解析进度。'
exit 0
`;
}

/**
 * 渲染「配对失效」脚本（码无效/过期；脚本通道不裸 JSON 错误码，硬规则②）。
 * 跑起来只打印一句人话到 stderr 并非零退出，引导回网页重铸。
 */
export function renderExpiredScript(): string {
  return `#!/bin/sh
printf '[Agora] %s\\n' '配对码已失效，请回到网页重新生成连接命令。' >&2
exit 1
`;
}
