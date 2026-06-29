package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// gunzip 解压 gzip 字节。
func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer r.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read gzip: %v", err)
	}
	return out
}

// splitBundlePart 复刻 worker 端 session-parse.ts splitBundlePart 的拆包口径：
//
//	text.split(`${BUNDLE_SENTINEL}\n`).filter(s => s.trim().length > 0)
func splitBundlePart(text string) []string {
	parts := strings.Split(text, BundleSentinel+"\n")
	out := make([]string, 0, len(parts))
	for _, s := range parts {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

// writeFiles 在 dir 下写若干 jsonl 文件，返回其绝对路径（排序，匹配 scanSessions 的稳定序）。
func writeFiles(t *testing.T, dir string, contents map[string]string) []string {
	t.Helper()
	var paths []string
	for name, body := range contents {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}

func mkPartsDir(t *testing.T) (string, []string) {
	t.Helper()
	dir := t.TempDir()
	partsDir := filepath.Join(dir, "parts")
	if err := os.MkdirAll(partsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir, []string{partsDir}
}

// incompressibleLines 生成约 n 字节、~200 字节/行的高熵（gzip 几乎压不动）内容，行尾带 \n，可按行切。
func incompressibleLines(n int) []byte {
	r := rand.New(rand.NewSource(42))
	var buf bytes.Buffer
	line := make([]byte, 200)
	for buf.Len() < n {
		for j := range line {
			c := byte(r.Intn(256))
			if c == '\n' {
				c = 'x' // 行内不放换行，行长可控。
			}
			line[j] = c
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	return buf.Bytes()
}

// TestPackFormatExact 校验单文件（≤recordMax）打包字节精确：sentinel 行 + 文件原文 + 换行（与旧版整文件一致）。
func TestPackFormatExact(t *testing.T) {
	dir, p := mkPartsDir(t)
	partsDir := p[0]

	fileBody := `{"type":"user","message":{"role":"user","content":"hi"}}` + "\n" +
		`{"type":"assistant","message":{"role":"assistant","content":"yo"}}`
	files := writeFiles(t, dir, map[string]string{"a.jsonl": fileBody})

	res, err := packFiles(files, partsDir, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}
	if res.NumParts() != 1 {
		t.Fatalf("NumParts = %d, want 1", res.NumParts())
	}

	gz, err := os.ReadFile(res.PartFiles[0])
	if err != nil {
		t.Fatal(err)
	}
	got := gunzip(t, gz)

	want := []byte(BundleSentinel + "\n")
	want = append(want, []byte(fileBody)...)
	want = append(want, '\n')

	if !bytes.Equal(got, want) {
		t.Fatalf("pack bytes mismatch:\n got=%q\nwant=%q", got, want)
	}
}

// TestPackSplitRoundTrip 校验小文件「打包 → split(__AGORA_FILE_BOUNDARY__\n)」往返还原每个文件原文。
func TestPackSplitRoundTrip(t *testing.T) {
	dir, p := mkPartsDir(t)
	partsDir := p[0]

	bodies := map[string]string{
		"a.jsonl": `{"k":1}` + "\n" + `{"k":2}`,
		"b.jsonl": `{"x":"中文与符号：；！"}` + "\n" + `{"y":"emoji 🚀 end"}`,
		"c.jsonl": `{"only":"one line no trailing newline"}`,
	}
	files := writeFiles(t, dir, bodies)

	res, err := packFiles(files, partsDir, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}

	got := allSegments(t, res)
	var want []string
	for _, f := range files {
		raw, _ := os.ReadFile(f)
		want = append(want, string(raw)+"\n")
	}
	if len(got) != len(want) {
		t.Fatalf("split count = %d, want %d\n got=%#v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("split[%d] mismatch:\n got=%q\nwant=%q", i, got[i], want[i])
		}
	}
}

// allSegments 按分片顺序解压并拆出全部段（worker 口径）。
func allSegments(t *testing.T, res *PackResult) []string {
	t.Helper()
	var segs []string
	for _, pf := range res.PartFiles {
		gz, err := os.ReadFile(pf)
		if err != nil {
			t.Fatal(err)
		}
		segs = append(segs, splitBundlePart(string(gunzip(t, gz)))...)
	}
	return segs
}

// TestPackBoundsCompressedSize 是 413 修复的核心断言：即便内容完全压不动，
// 每个分片【压缩后】也 ≤ partTargetCompressed + recordMax（远低于 web 那层 32m）。
func TestPackBoundsCompressedSize(t *testing.T) {
	dir, p := mkPartsDir(t)
	partsDir := p[0]

	// 约 50MiB 不可压内容（带行）。
	files := writeFiles(t, dir, map[string]string{"big.jsonl": string(incompressibleLines(50 << 20))})

	res, err := packFiles(files, partsDir, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}
	if res.NumParts() < 2 {
		t.Fatalf("不可压 50MiB 应切多片，NumParts = %d", res.NumParts())
	}

	bound := int64(partTargetCompressed + recordMax + (1 << 20)) // +1MiB 给 gzip flush 同步标记的余量。
	for i, pf := range res.PartFiles {
		fi, err := os.Stat(pf)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Size() > bound {
			t.Fatalf("分片 %d 压缩后 %d 字节，超出上界 %d（会撞 nginx 32m）", i, fi.Size(), bound)
		}
		// 同时硬性确认远低于 32m。
		if fi.Size() >= 32<<20 {
			t.Fatalf("分片 %d = %d ≥ 32m，必被 nginx 413", i, fi.Size())
		}
	}
}

// TestPackSplitsHugeFile 校验超大单文件被按行切成多条记录，且各段拼回 = 原文件（无数据丢失）。
func TestPackSplitsHugeFile(t *testing.T) {
	dir, p := mkPartsDir(t)
	partsDir := p[0]

	raw := incompressibleLines(20 << 20) // 20MiB（> recordMax 6MiB），不可压 → 必切多片。
	files := writeFiles(t, dir, map[string]string{"huge.jsonl": string(raw)})

	res, err := packFiles(files, partsDir, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}
	if res.NumParts() < 2 {
		t.Fatalf("20MiB 不可压单文件应切多片，NumParts = %d", res.NumParts())
	}

	// worker 把每段当一个会话片段；各段去掉打包追加的那一个换行后拼回 = 原文件（不丢数据）。
	var reassembled bytes.Buffer
	for _, seg := range allSegments(t, res) {
		reassembled.WriteString(strings.TrimSuffix(seg, "\n"))
	}
	if !bytes.Equal(reassembled.Bytes(), raw) {
		t.Fatalf("超大文件切片后拼回与原文件不一致（长度 got=%d want=%d）", reassembled.Len(), len(raw))
	}
}

// TestPackShaMatchesGzipContent 校验 PartShas = part-i.gz 内容的 sha256（hex 小写），与上传契约 contentSha256 一致。
func TestPackShaMatchesGzipContent(t *testing.T) {
	dir, p := mkPartsDir(t)
	partsDir := p[0]

	// 不可压数据切多片，逐片验 sha。
	files := writeFiles(t, dir, map[string]string{"x.jsonl": string(incompressibleLines(40 << 20))})

	res, err := packFiles(files, partsDir, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}
	if res.NumParts() < 1 {
		t.Fatalf("NumParts = %d", res.NumParts())
	}

	for i, pf := range res.PartFiles {
		raw, err := os.ReadFile(pf)
		if err != nil {
			t.Fatal(err)
		}
		want := hex.EncodeToString((func() []byte { s := sha256.Sum256(raw); return s[:] })())
		if res.PartShas[i] != want {
			t.Fatalf("part %d sha = %s, want %s", i, res.PartShas[i], want)
		}
		if res.PartShas[i] != strings.ToLower(res.PartShas[i]) {
			t.Fatalf("part %d sha not lowercase: %s", i, res.PartShas[i])
		}
		// 文件名递增。
		if filepath.Base(pf) != "part-"+itoa(i)+".gz" {
			t.Fatalf("part %d name = %s", i, filepath.Base(pf))
		}
	}
}

// TestPackProgressPerFile 校验进度回调每个文件触发一次（节流交给 reporter，不在 packer）。
func TestPackProgressPerFile(t *testing.T) {
	dir, p := mkPartsDir(t)
	partsDir := p[0]

	contents := map[string]string{}
	for i := 0; i < 1100; i++ {
		contents["f"+itoa(i)+".jsonl"] = "x"
	}
	files := writeFiles(t, dir, contents)

	var calls []int
	lastTotal := -1
	progress := func(cnt, total int) { calls = append(calls, cnt); lastTotal = total }

	if _, err := packFiles(files, partsDir, progress); err != nil {
		t.Fatalf("packFiles: %v", err)
	}
	if len(calls) != 1100 {
		t.Fatalf("progress 调用 %d 次，want 1100", len(calls))
	}
	if calls[0] != 1 || calls[1099] != 1100 {
		t.Fatalf("progress 计数 first=%d last=%d，want 1 / 1100", calls[0], calls[1099])
	}
	if lastTotal != 1100 {
		t.Fatalf("progress total = %d, want 1100", lastTotal)
	}
}

// TestScanSessions 校验扫描只收两个根目录下非空 *.jsonl。
func TestScanSessions(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude", "projects", "proj-a")
	codexDir := filepath.Join(home, ".codex", "sessions", "2026", "06")
	for _, d := range []string{claudeDir, codexDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite := func(p, body string) {
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite(filepath.Join(claudeDir, "s1.jsonl"), `{"k":1}`)
	mustWrite(filepath.Join(codexDir, "s2.jsonl"), `{"k":2}`)
	mustWrite(filepath.Join(claudeDir, "empty.jsonl"), ``)
	mustWrite(filepath.Join(claudeDir, "note.txt"), `hello`)
	otherDir := filepath.Join(home, ".other")
	if err := os.MkdirAll(otherDir, 0o700); err != nil {
		t.Fatal(err)
	}
	mustWrite(filepath.Join(otherDir, "x.jsonl"), `{"k":3}`)

	got, err := scanSessions(home)
	if err != nil {
		t.Fatalf("scanSessions: %v", err)
	}
	want := []string{filepath.Join(claudeDir, "s1.jsonl"), filepath.Join(codexDir, "s2.jsonl")}
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("scan got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("scan[%d] = %s, want %s", i, got[i], want[i])
		}
	}
}

// TestSha256Hex 校验 sha256Hex 与标准库一致（hex 小写）。
func TestSha256Hex(t *testing.T) {
	in := []byte("hello agora")
	sum := sha256.Sum256(in)
	want := hex.EncodeToString(sum[:])
	if got := sha256Hex(in); got != want {
		t.Fatalf("sha256Hex = %s, want %s", got, want)
	}
}

// TestItoa 校验无依赖 itoa。
func TestItoa(t *testing.T) {
	cases := map[int]string{0: "0", 7: "7", 42: "42", 1000: "1000", 16777216: "16777216"}
	for in, want := range cases {
		if got := itoa(in); got != want {
			t.Fatalf("itoa(%d) = %s, want %s", in, got, want)
		}
	}
}
