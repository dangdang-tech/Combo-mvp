package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestComma(t *testing.T) {
	cases := map[int]string{0: "0", 7: "7", 999: "999", 1000: "1,000", 7370: "7,370", 1234567: "1,234,567", -1000: "-1,000"}
	for in, want := range cases {
		if got := comma(in); got != want {
			t.Fatalf("comma(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestReporterSelection(t *testing.T) {
	t.Setenv("AGORA_FORCE_TUI", "")
	t.Setenv("AGORA_NO_TUI", "1")
	if _, ok := newReporter().(*plainReporter); !ok {
		t.Fatal("AGORA_NO_TUI=1 应返回 plainReporter")
	}
	t.Setenv("AGORA_NO_TUI", "")
	t.Setenv("AGORA_FORCE_TUI", "1")
	if _, ok := newReporter().(*ttyReporter); !ok {
		t.Fatal("AGORA_FORCE_TUI=1 应返回 ttyReporter")
	}
}

// TestTTYUploadBar：上传进度条就地刷新（\r）、有方块条、百分比、分片计数、清行尾、不丢「N 路并发」头。
func TestTTYUploadBar(t *testing.T) {
	var buf bytes.Buffer
	r := &ttyReporter{w: &buf, color: false}
	r.uploadStart(84, 8)
	r.uploadProgress(42, 84) // 50%（首帧，barActive=false 必绘）
	r.uploadProgress(84, 84) // 100%（done==total，force 必绘）
	r.success()

	out := buf.String()
	for _, want := range []string{"\r", "▕", "█", "░", "▏", "100%", "84 / 84", "\x1b[K", "8 路并发", "✓ 上传完成", "用时", "0:00"} {
		if !strings.Contains(out, want) {
			t.Fatalf("tty 上传输出缺少 %q\n全文：%q", want, out)
		}
	}
}

func TestFmtClock(t *testing.T) {
	cases := map[int]string{0: "0:00", 7: "0:07", 59: "0:59", 60: "1:00", 83: "1:23", 605: "10:05"}
	for sec, want := range cases {
		if got := fmtClock(time.Duration(sec) * time.Second); got != want {
			t.Fatalf("fmtClock(%ds) = %q, want %q", sec, got, want)
		}
	}
}

// TestTTYColor：color=true 时进度条含品牌砖红 ANSI；NO_COLOR 风格（color=false）则不含。
func TestTTYColor(t *testing.T) {
	var on, off bytes.Buffer
	(&ttyReporter{w: &on, color: true}).packProgress(3500, 7370)
	(&ttyReporter{w: &off, color: false}).packProgress(3500, 7370)

	if !strings.Contains(on.String(), ansiAccent) && !strings.Contains(on.String(), ansiBold) {
		t.Fatalf("color=true 应含砖红 ANSI，实得：%q", on.String())
	}
	if strings.Contains(off.String(), "\x1b[38;2;") {
		t.Fatalf("color=false 不应含真彩 ANSI，实得：%q", off.String())
	}
}
