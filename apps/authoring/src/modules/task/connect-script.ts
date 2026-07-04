// 本机助手脚本渲染（GET /connect/script 下发，`curl ... | sh` 直跑）。
//   sh 只做守门（检测 python3），重活在内嵌 python3 上传器里：扫 ~/.claude/projects 与
//   ~/.codex/sessions 的 *.jsonl → 按 BUNDLE_SENTINEL 整文件打包切片 → 逐片 POST /connect/upload
//   （JSON 体：pairingCode/partIndex/totalParts/content）。worker 端拆包口径见 session-parse.splitBundle。
//   文案硬约束：明确是「在本机读取后全量上传原文、云端解析去敏」，绝不出现「数据不出本机」等字眼。
import { BUNDLE_SENTINEL } from './session-parse.js';

/** POSIX shell 单引号安全注入（' → '\''，防注入闭合脚本字符串）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ConnectScriptParams {
  /** 对外基址，形如 https://agora.app（据请求 Host + x-forwarded-proto 算）。 */
  base: string;
  /** 一次性配对码（助手凭它上传）。 */
  pairingCode: string;
}

/** 渲染助手脚本（active 配对）。 */
export function renderConnectScript(p: ConnectScriptParams): string {
  return `#!/bin/sh
# Agora 本机助手 — 在本机读取你的对话历史后，把原文【完整上传】到云端，
#   再由云端解析、抹掉手机号/密钥这类隐私信息后用于能力提取。
set -u

AGORA_BASE=${shq(p.base)}
AGORA_CODE=${shq(p.pairingCode)}
export AGORA_BASE AGORA_CODE

if ! command -v python3 >/dev/null 2>&1; then
  printf '[Agora] %s\\n' '这台电脑没有 python3，命令行方式用不了。请回到任务页查看其它方式。' >&2
  exit 1
fi

exec python3 - <<'AGORA_PY'
import json, os, pathlib, sys, urllib.error, urllib.request

BASE = os.environ['AGORA_BASE'].rstrip('/')
CODE = os.environ['AGORA_CODE']
SENTINEL = ${JSON.stringify(BUNDLE_SENTINEL)}
PART_LIMIT = 2 * 1024 * 1024  # 单片 2MB 文本，服务端 JSON 体上限之内

def log(msg):
    print('[Agora] ' + msg, file=sys.stderr)

roots = [pathlib.Path.home() / '.claude' / 'projects', pathlib.Path.home() / '.codex' / 'sessions']
files = []
for root in roots:
    if root.is_dir():
        files.extend(sorted(root.rglob('*.jsonl')))
if not files:
    log('没扫到可上传的对话历史（~/.claude/projects 或 ~/.codex/sessions 为空）。')
    sys.exit(1)
log('找到 %d 个会话文件，开始打包上传…' % len(files))

# 整文件打包：sentinel 行 + 文件原文；单个分片只含整文件（不跨分片切文件）。
parts, buf, size = [], [], 0
for f in files:
    try:
        text = f.read_text('utf-8', errors='replace')
    except OSError:
        continue
    piece = SENTINEL + '\\n' + text + '\\n'
    if buf and size + len(piece) > PART_LIMIT:
        parts.append(''.join(buf)); buf, size = [], 0
    buf.append(piece); size += len(piece)
if buf:
    parts.append(''.join(buf))

total = len(parts)
for i, content in enumerate(parts):
    body = json.dumps({'pairingCode': CODE, 'partIndex': i, 'totalParts': total, 'content': content}).encode('utf-8')
    req = urllib.request.Request(BASE + '/api/v1/connect/upload', data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get('error', {}).get('userMessage', '')
        except Exception:
            msg = ''
        log(msg or ('上传失败（HTTP %d），重跑本命令续传。' % e.code))
        sys.exit(1)
    except Exception as e:
        log('网络异常：%s。重跑本命令续传。' % e)
        sys.exit(1)
    log('已上传 %d / %d 片' % (data['data']['landed'], total))

log('上传完成，云端已自动开始解析与提取。回到任务页查看进度。')
AGORA_PY
`;
}

/** 配对失效脚本（码无效/过期；脚本通道不裸 JSON 错误码）：打印一句人话并非零退出。 */
export function renderExpiredScript(): string {
  return `#!/bin/sh
printf '[Agora] %s\\n' '配对码已失效，请回到任务页重新生成连接命令。' >&2
exit 1
`;
}
