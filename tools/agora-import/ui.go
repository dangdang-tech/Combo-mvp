package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// reporter 进度展示口径。两种实现：
//   - ttyReporter：终端（TTY）下的彩色 TUI，扫描/打包/上传各一行，上传是【就地刷新的进度条】。
//   - plainReporter：非 TTY（管道/重定向/CI）下沿用逐行 [Agora] 文案，可被解析、不刷屏失控。
//
// 同一时刻只有一个 goroutine 调用 reporter（打包在单循环、上传进度在单一收集循环），故无需加锁。
type reporter interface {
	scanStart()
	packProgress(done, total int)
	uploadStart(parts, jobs int)
	uploadProgress(done, total int)
	success()
	failf(format string, args ...any)
}

// newReporter 按 stderr 是否 TTY 选实现；AGORA_FORCE_TUI=1 强开（测试用）、AGORA_NO_TUI=1 强关、NO_COLOR 去色。
func newReporter() reporter {
	now := time.Now()
	tty := os.Getenv("AGORA_FORCE_TUI") == "1" || isStderrTTY()
	if os.Getenv("AGORA_NO_TUI") == "1" || !tty {
		return &plainReporter{start: now}
	}
	return &ttyReporter{w: os.Stderr, color: os.Getenv("NO_COLOR") == "", start: now}
}

// fmtClock 把耗时格式化成 m:ss（如 1:23、0:07）。
func fmtClock(d time.Duration) string {
	total := int(d.Seconds())
	if total < 0 {
		total = 0
	}
	sec := total % 60
	s := itoa(sec)
	if sec < 10 {
		s = "0" + s
	}
	return itoa(total/60) + ":" + s
}

// isStderrTTY 纯标准库判 stderr 是否终端：字符设备位（管道/普通文件没有）。
func isStderrTTY() bool {
	fi, err := os.Stderr.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// —— ANSI（绿色主色：进度条/强调用绿；空槽与次要文案用中性灰）——
const (
	ansiReset  = "\x1b[0m"
	ansiAccent = "\x1b[38;2;60;160;95m"    // 进度条边/次强调（绿）
	ansiBold   = "\x1b[1;38;2;60;160;95m"  // 进度条填充/标签/百分比（粗绿）
	ansiGreen  = "\x1b[1;38;2;74;172;104m" // ✓ 完成（更亮的绿）
	ansiDim    = "\x1b[38;2;150;145;138m"  // 空槽 ░ / 次要文案（灰）
	ansiClrEOL = "\x1b[K"                  // 清到行尾（就地刷新时擦掉残留）。
)

// —— 纯文本实现（非 TTY）——
type plainReporter struct{ start time.Time }

func (p *plainReporter) line(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[Agora] "+format+"\n", a...)
}
func (p *plainReporter) elapsed() time.Duration {
	if p.start.IsZero() {
		return 0
	}
	return time.Since(p.start)
}
func (p *plainReporter) scanStart() { p.line("正在查找本机对话历史…") }
func (p *plainReporter) packProgress(done, total int) {
	if done%500 == 0 || done == total {
		p.line("正在打包… 已处理 %d / %d 个会话", done, total)
	}
}
func (p *plainReporter) uploadStart(parts, jobs int) {
	p.line("打包成 %d 个分片，正在并发上传到云端（%d 路并发，云端会抹掉隐私信息）…", parts, jobs)
}
func (p *plainReporter) uploadProgress(done, total int) {
	p.line("已上传 %d / %d 个分片 …", done, total)
}
func (p *plainReporter) success() {
	p.line("上传完成（用时 %s），回到网页查看云端解析进度。", fmtClock(p.elapsed()))
}
func (p *plainReporter) failf(format string, a ...any) { p.line(format, a...) }

// —— 彩色 TUI 实现（TTY）——
type ttyReporter struct {
	w         io.Writer
	color     bool
	started   bool      // 头部是否已打
	barActive bool      // 当前是否有一条就地刷新的进度条占着行
	lastDraw  time.Time // 节流：进度条最多每 ~60ms 重绘一次
	start     time.Time // 起始时刻（耗时统计）。
}

func (t *ttyReporter) c(code, s string) string {
	if !t.color {
		return s
	}
	return code + s + ansiReset
}

func (t *ttyReporter) elapsed() time.Duration {
	if t.start.IsZero() {
		return 0
	}
	return time.Since(t.start)
}

func (t *ttyReporter) header() {
	if t.started {
		return
	}
	t.started = true
	fmt.Fprintln(t.w, "\n"+t.c(ansiBold, "  Agora")+t.c(ansiDim, "  本机助手 · 上传对话历史"))
}

// endBar 收束当前进度条（换行定格），让后续整行文案另起一行、不覆盖进度条。
func (t *ttyReporter) endBar() {
	if t.barActive {
		fmt.Fprint(t.w, "\n")
		t.barActive = false
	}
}

func (t *ttyReporter) scanStart() {
	t.header()
	fmt.Fprintln(t.w, t.c(ansiDim, "  正在查找本机对话历史…"))
}

// drawBar 就地刷新一条进度条：\r 回行首重绘、\x1b[K 擦残留、不换行。force=true 时不受节流约束（用于 0%/100%）。
func (t *ttyReporter) drawBar(label string, cur, total int, suffix string, force bool) {
	now := time.Now()
	if !force && t.barActive && now.Sub(t.lastDraw) < 60*time.Millisecond {
		return
	}
	t.lastDraw = now
	const width = 26
	if total < 1 {
		total = 1
	}
	filled := cur * width / total
	if filled > width {
		filled = width
	}
	if filled < 0 {
		filled = 0
	}
	var sb strings.Builder
	sb.WriteString("\r  ")
	sb.WriteString(t.c(ansiBold, label))
	sb.WriteString("  ")
	sb.WriteString(t.c(ansiAccent, "▕"))
	sb.WriteString(t.c(ansiBold, strings.Repeat("█", filled)))
	sb.WriteString(t.c(ansiDim, strings.Repeat("░", width-filled)))
	sb.WriteString(t.c(ansiAccent, "▏"))
	sb.WriteString("  ")
	sb.WriteString(suffix)
	sb.WriteString(ansiClrEOL)
	fmt.Fprint(t.w, sb.String())
	t.barActive = true
}

func (t *ttyReporter) packProgress(done, total int) {
	t.drawBar("打包", done, total, t.c(ansiDim, comma(done)+" / "+comma(total)+" 会话"), done == total)
}

func (t *ttyReporter) uploadStart(parts, jobs int) {
	t.endBar()
	fmt.Fprintln(t.w, t.c(ansiDim, "  打包成 ")+t.c(ansiBold, itoa(parts))+
		t.c(ansiDim, " 个分片，正在上传到云端（"+itoa(jobs)+" 路并发，云端会抹掉隐私信息）…"))
}

func (t *ttyReporter) uploadProgress(done, total int) {
	pct := done * 100 / max(total, 1)
	suffix := t.c(ansiDim, comma(done)+" / "+comma(total)+" 分片 · ") +
		t.c(ansiBold, itoa(pct)+"%") +
		t.c(ansiDim, "  "+fmtClock(t.elapsed()))
	t.drawBar("上传", done, total, suffix, done == total)
}

func (t *ttyReporter) success() {
	t.endBar()
	fmt.Fprintln(t.w, t.c(ansiGreen, "  ✓ 上传完成")+
		t.c(ansiDim, " · 用时 "+fmtClock(t.elapsed())+"，回到网页查看云端解析进度。"))
}

func (t *ttyReporter) failf(format string, a ...any) {
	t.endBar()
	fmt.Fprintln(t.w, t.c(ansiBold, "  ✗ ")+fmt.Sprintf(format, a...))
}

// comma 给整数加千分位（7370 → 7,370）。
func comma(n int) string {
	s := itoa(n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	if len(s) <= 3 {
		if neg {
			return "-" + s
		}
		return s
	}
	var out []byte
	for i := 0; i < len(s); i++ {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, s[i])
	}
	if neg {
		return "-" + string(out)
	}
	return string(out)
}
