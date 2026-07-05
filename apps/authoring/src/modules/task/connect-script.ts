// 本机助手脚本渲染（GET /connect/script 下发，`curl ... | sh` 直跑）。
//   sh 只做守门（检测 python3），重活在内嵌 python3 上传器里：扫 ~/.claude/projects 与
//   ~/.codex/sessions 的 *.jsonl → 按 BUNDLE_SENTINEL 打包、按行切片 → 逐片 POST /connect/upload
//   （JSON 体：pairingCode/partIndex/totalParts/content）。worker 端拆包口径见 session-parse.splitBundle。
//   终端体验对齐旧 Go 助手（tools/agora-import/ui.go）：TTY 下绿色就地刷新进度条（打包/上传各一条，
//   60ms 节流），非 TTY（管道/CI）退化为逐行日志。
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
import json, os, pathlib, sys, time, urllib.error, urllib.request

BASE = os.environ['AGORA_BASE'].rstrip('/')
CODE = os.environ['AGORA_CODE']
SENTINEL = ${JSON.stringify(BUNDLE_SENTINEL)}
PART_LIMIT = 2 * 1024 * 1024  # 单片 2MB 文本；服务端 32MB 体上限对 JSON 转义膨胀有充分余量

# ---------- 终端展示（对齐旧 Go 助手的 TUI）：TTY 就地进度条，非 TTY 逐行日志 ----------
IS_TTY = sys.stderr.isatty()
ACCENT = '\\x1b[38;2;60;160;95m'   # 进度条边（绿）
BOLD   = '\\x1b[1;38;2;60;160;95m' # 进度条填充/标签/百分比（粗绿）
DIM    = '\\x1b[38;2;150;145;138m' # 空槽/次要文案（灰）
RESET  = '\\x1b[0m'
CLREOL = '\\x1b[K'

def c(color, s):
    return color + s + RESET if IS_TTY else s

def log(msg):
    print('[Agora] ' + msg, file=sys.stderr)

_start = time.time()
_last_draw = 0.0
_bar_active = False

def fmt_clock():
    d = int(time.time() - _start)
    return '%d 分 %d 秒' % (d // 60, d % 60) if d >= 60 else '%d 秒' % d

def draw_bar(label, cur, total, suffix, force=False):
    """就地刷新一条进度条（回行首重绘 + 擦残留，不换行）；60ms 节流，0%/100% 强制画。"""
    global _last_draw, _bar_active
    if not IS_TTY:
        return
    now = time.time()
    if not force and _bar_active and now - _last_draw < 0.06:
        return
    _last_draw = now
    width = 26
    total = max(total, 1)
    filled = min(max(cur * width // total, 0), width)
    sys.stderr.write('\\r  ' + c(BOLD, label) + '  ' + c(ACCENT, '▕')
                     + c(BOLD, '█' * filled) + c(DIM, '░' * (width - filled))
                     + c(ACCENT, '▏') + '  ' + c(DIM, suffix) + CLREOL)
    sys.stderr.flush()
    _bar_active = True

def end_bar():
    global _bar_active
    if _bar_active:
        sys.stderr.write('\\n')
        _bar_active = False

def fail(msg):
    end_bar()
    log(msg)
    sys.exit(1)

if IS_TTY:
    sys.stderr.write('\\n  ' + c(BOLD, 'Agora') + c(DIM, '  本机助手 · 上传对话历史') + '\\n')
    sys.stderr.write(c(DIM, '  正在查找本机对话历史…') + '\\n')
else:
    log('正在查找本机对话历史…')

roots = [pathlib.Path.home() / '.claude' / 'projects', pathlib.Path.home() / '.codex' / 'sessions']
files = []
for root in roots:
    if root.is_dir():
        files.extend(sorted(root.rglob('*.jsonl')))
if not files:
    fail('没扫到可上传的对话历史（~/.claude/projects 或 ~/.codex/sessions 为空）。')
if not IS_TTY:
    log('找到 %d 个会话文件，开始打包上传…' % len(files))

# 打包后按【行】切片：服务端重组是分片间换行拼接，行边界切分对 JSONL 无损；
# 单个超限文件也会被切开（整文件打包会产生超大分片，被服务端请求体上限拒收）。
bundle_lines = []
for n, f in enumerate(files):
    try:
        text = f.read_text('utf-8', errors='replace')
    except OSError:
        continue
    bundle_lines.append(SENTINEL)
    bundle_lines.extend(text.splitlines())
    draw_bar('打包', n + 1, len(files), '%d / %d 会话' % (n + 1, len(files)), n + 1 == len(files))
end_bar()

parts, buf, size = [], [], 0
for line in bundle_lines:
    piece_len = len(line) + 1
    if buf and size + piece_len > PART_LIMIT:
        parts.append('\\n'.join(buf)); buf, size = [], 0
    buf.append(line); size += piece_len
if buf:
    parts.append('\\n'.join(buf))
if not parts:
    fail('会话文件都是空的，没有可上传内容。')

total = len(parts)
draw_bar('上传', 0, total, '0 / %d 片' % total, True)
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
        fail(msg or ('上传失败（HTTP %d），重跑本命令续传。' % e.code))
    except Exception as e:
        fail('网络异常：%s。重跑本命令续传。' % e)
    landed = data['data']['landed']
    if IS_TTY:
        draw_bar('上传', landed, total, '%d / %d 片' % (landed, total), landed == total)
    else:
        log('已上传 %d / %d 片' % (landed, total))
end_bar()

if IS_TTY:
    sys.stderr.write('  ' + c(ACCENT, '✓ 上传完成')
                     + c(DIM, ' · 用时 ' + fmt_clock() + '，云端已自动开始解析与提取，回到任务页查看进度。') + '\\n')
else:
    log('上传完成（用时 %s），云端已自动开始解析与提取。回到任务页查看进度。' % fmt_clock())
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
