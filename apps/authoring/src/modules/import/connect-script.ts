// B-21 · 本机助手「引导脚本」渲染（20-step1-import §3.2）。
//   GET /import/connect/script 下发的可执行 shell 脚本（text/x-shellscript，经 `sh` 跑）。
//   ⚠ 本脚本只是【瘦引导器】，不再在 shell 里扫描/打包/并发上传——纯 shell 的并发+取消+清理有严重 bug
//     （Ctrl+C 不停、孤儿后台任务往已删目录写 "No such file" 刷屏）。重活全部迁进预编译 Go 二进制
//     （健壮的 context 取消 + 信号处理），脚本只负责：检测平台 → 下载对应二进制 → 校验 sha256 → exec 之。
//   引导步骤（纯 POSIX sh + curl，可 `curl ... | sh` 直跑）：
//     1) uname -s/-m 检测平台（Darwin→darwin / Linux→linux；arm64|aarch64→arm64 / x86_64|amd64→amd64）；
//        无 curl 或平台不支持 → 人话引导回网页、exit 1。
//     2) curl -fsSL 下载 {BASE}/api/v1/import/connect/bin/agora-import-{os}-{arch} 与同名 .sha256 到 mktemp 目录。
//     3) 用 shasum / sha256sum 校验下载字节与 .sha256 一致（不一致 → 报错 exit 1，绝不跑未校验二进制）。
//     4) chmod +x 后 exec 该二进制，通过 env 下发 AGORA_BASE/AGORA_PAIR_ID/AGORA_CODE/AGORA_SOURCE。
//   二进制承接的协议（保持不变，仅由 Go 实现）：扫 ~/.claude/projects + ~/.codex/sessions 全量原文 →
//     按 BUNDLE_SENTINEL 整文件打包成 gzip 分片 → 并发 multipart 直传 POST /import/connect/upload；
//     pairId/partIndex/totalParts/contentSha256 走 query，鉴权 Authorization: Bearer <code>，
//     per-part Idempotency-Key = pair-{pairId}-{partIndex}-{sha}。worker 端拆包口径不变（splitBundlePart）。
//   健壮性（用户实测命中，引导脚本仍须遵守）：
//     1) 所有 shell 变量用 ${VAR} 大括号包裹（裸 $VAR 紧跟中文标点在 macOS bash+某些 locale 会把多字节并进变量名 + set -u 崩）。
//     2) 下载 curl 加 -fsSL --noproxy '*' -L --location-trusted（BASE 万一是 http、命中 80→443 跳转仍跟随且不走系统代理）。
//   文案口径硬约束（导入-04/05/29）：必须是「在本机读取后【全量上传原文】、云端解析去敏」；
//     绝不出现「数据不出本机 / 仅上传精简 / 原始日志不出本机 / 本机解析只传提取后」等字眼。

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
 * 渲染助手「引导脚本」（active 配对）。脚本在用户本机跑：检测平台 → 下载预编译 Go 二进制 → 校验 sha256 →
 *   exec 之（env 下发 BASE/pairId/code/source）。重活（本机读取全量原文 → 打包 → 并发上传）全在 Go 二进制里，
 *   脚本本身不扫描/不打包/不上传。纯 POSIX sh + curl，可 `curl ... | sh` 直跑。
 */
export function renderConnectScript(p: ConnectScriptParams): string {
  return `#!/bin/sh
# Agora 本机助手（引导器）— 下载本机助手程序，由它在本机读取你的对话历史后，把原文【完整上传】到云端，
#   再由云端解析、抹掉手机号/密钥这类隐私信息后用于后续步骤。
set -u

BASE=${shq(p.base)}
PAIR_ID=${shq(p.pairId)}
CODE=${shq(p.pairingCode)}
SOURCE='mixed'

log() { printf '[Agora] %s\\n' "$1" >&2; }

# 0. 没有 curl 就用不了命令行方式（Windows / 极简环境）——给人话出口，引导回网页。
if ! command -v curl >/dev/null 2>&1; then
  log '这台电脑没有 curl，命令行方式用不了。请回到网页，改用浏览器上传。'
  exit 1
fi

# 1. 检测平台：操作系统 + CPU 架构 → 拼出二进制名 agora-import-{os}-{arch}。
OS_RAW=$(uname -s 2>/dev/null || printf '')
ARCH_RAW=$(uname -m 2>/dev/null || printf '')
case "\${OS_RAW}" in
  Darwin) OS='darwin' ;;
  Linux) OS='linux' ;;
  *)
    log '当前系统暂不支持命令行方式。请回到网页，改用浏览器上传。'
    exit 1
    ;;
esac
case "\${ARCH_RAW}" in
  arm64|aarch64) ARCH='arm64' ;;
  x86_64|amd64) ARCH='amd64' ;;
  *)
    log '当前 CPU 架构暂不支持命令行方式。请回到网页，改用浏览器上传。'
    exit 1
    ;;
esac
ASSET="agora-import-\${OS}-\${ARCH}"
BIN_URL="\${BASE}/api/v1/import/connect/bin/\${ASSET}"

# 2. 下载二进制 + 它的 sha256 到临时目录（退出时清理）。
TMPD=$(mktemp -d 2>/dev/null) || { TMPD="/tmp/agora-import-$$.d"; mkdir -p "\${TMPD}"; }
trap 'rm -rf "\${TMPD}"' EXIT INT TERM HUP
BIN_PATH="\${TMPD}/\${ASSET}"
SHA_PATH="\${TMPD}/\${ASSET}.sha256"

log '正在下载本机助手程序…'
# -fsSL：失败即非零、静默进度、跟随重定向；--noproxy '*' 直连不走系统代理；
#   -L --location-trusted：BASE 万一是 http、命中 80→443 跳转仍跟随。
if ! curl -fsSL --noproxy '*' -L --location-trusted -o "\${BIN_PATH}" "\${BIN_URL}"; then
  log '下载本机助手程序失败。请检查网络后重试，或回网页改用浏览器上传。'
  exit 1
fi
if ! curl -fsSL --noproxy '*' -L --location-trusted -o "\${SHA_PATH}" "\${BIN_URL}.sha256"; then
  log '下载校验信息失败。请检查网络后重试，或回网页改用浏览器上传。'
  exit 1
fi

# 3. 校验 sha256（拿不到校验工具或不一致 → 绝不运行未校验的二进制）。
WANT=$(awk '{print $1}' "\${SHA_PATH}" 2>/dev/null | tr -d ' \\n\\r')
if [ -z "\${WANT}" ]; then
  log '校验信息为空，无法确认程序完整性。请回网页改用浏览器上传。'
  exit 1
fi
if command -v shasum >/dev/null 2>&1; then
  GOT=$(shasum -a 256 "\${BIN_PATH}" 2>/dev/null | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  GOT=$(sha256sum "\${BIN_PATH}" 2>/dev/null | awk '{print $1}')
else
  log '这台电脑没有 sha256 校验工具（shasum/sha256sum），无法确认程序完整性。请回网页改用浏览器上传。'
  exit 1
fi
if [ "\${GOT}" != "\${WANT}" ]; then
  log '下载的助手程序校验不通过（可能被网络损坏或篡改）。请重试，或回网页改用浏览器上传。'
  exit 1
fi

# 4. 赋可执行权后 exec 之；参数全走 env 下发（AGORA_BASE/PAIR_ID/CODE/SOURCE）。
#    exec 让二进制接管当前进程：Ctrl+C 直达二进制的信号处理（健壮取消/清理，不再有 shell 孤儿任务）。
chmod +x "\${BIN_PATH}" 2>/dev/null || true
AGORA_BASE="\${BASE}" \\
AGORA_PAIR_ID="\${PAIR_ID}" \\
AGORA_CODE="\${CODE}" \\
AGORA_SOURCE="\${SOURCE}" \\
exec "\${BIN_PATH}"
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
