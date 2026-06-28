package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
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
//
// 用于断言「打包→split」往返还原各文件原文。
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

// TestPackFormatExact 校验单文件打包字节精确：sentinel 行 + 文件原文 + 换行。
func TestPackFormatExact(t *testing.T) {
	dir := t.TempDir()
	partsDir := filepath.Join(dir, "parts")
	if err := os.MkdirAll(partsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	fileBody := `{"type":"user","message":{"role":"user","content":"hi"}}` + "\n" +
		`{"type":"assistant","message":{"role":"assistant","content":"yo"}}`
	files := writeFiles(t, dir, map[string]string{"a.jsonl": fileBody})

	// partMax 很大 → 全部进一片。
	res, err := packFiles(files, partsDir, 1<<30, nil)
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

// TestPackSplitRoundTrip 校验「打包 → split(__AGORA_FILE_BOUNDARY__\n)」往返还原每个文件原文。
func TestPackSplitRoundTrip(t *testing.T) {
	dir := t.TempDir()
	partsDir := filepath.Join(dir, "parts")
	if err := os.MkdirAll(partsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	bodies := map[string]string{
		"a.jsonl": `{"k":1}` + "\n" + `{"k":2}`,
		"b.jsonl": `{"x":"中文与符号：；！"}` + "\n" + `{"y":"emoji 🚀 end"}`,
		"c.jsonl": `{"only":"one line no trailing newline"}`,
	}
	files := writeFiles(t, dir, bodies)

	res, err := packFiles(files, partsDir, 1<<30, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}

	// 合并所有分片解压文本（一片即可，但通用处理）。
	var combined bytes.Buffer
	for _, pf := range res.PartFiles {
		gz, err := os.ReadFile(pf)
		if err != nil {
			t.Fatal(err)
		}
		combined.Write(gunzip(t, gz))
	}

	got := splitBundlePart(combined.String())

	// 期望：按 files 顺序，每段 = 文件原文 + 末尾换行（最后一段也带打包追加的换行）。
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

	// 再核：去掉每段末换行后等于原文件去尾换行（worker toLines 会 trim，故语义还原）。
	for i, f := range files {
		raw, _ := os.ReadFile(f)
		gotTrim := strings.TrimRight(got[i], "\n")
		wantTrim := strings.TrimRight(string(raw), "\n")
		if gotTrim != wantTrim {
			t.Fatalf("round-trip content[%d] mismatch:\n got=%q\nwant=%q", i, gotTrim, wantTrim)
		}
	}
}

// TestPackPartMaxBoundary 校验「当前缓冲未压缩字节 ≥ partMax 即 flush」的分片切分点，且只切整文件。
func TestPackPartMaxBoundary(t *testing.T) {
	dir := t.TempDir()
	partsDir := filepath.Join(dir, "parts")
	if err := os.MkdirAll(partsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// 每个文件 1000 字节正文。sentinel 行 = len("__AGORA_FILE_BOUNDARY__\n") = 24；尾换行 1。
	// 单文件贡献 = 24 + 1000 + 1 = 1025 字节。
	body := strings.Repeat("x", 1000)
	contents := map[string]string{}
	for i := 0; i < 5; i++ {
		contents["f"+itoa(i)+".jsonl"] = body
	}
	files := writeFiles(t, dir, contents)

	// partMax = 2049：第 1 文件后缓冲 1025（<2049 不切）；第 2 文件后 2050（≥2049 切片0）；
	//   第 3 文件后 1025；第 4 文件后 2050（≥2049 切片1）；第 5 文件后 1025（末尾 flush 片2）。
	// 期望 3 片：片0=2文件、片1=2文件、片2=1文件。
	res, err := packFiles(files, partsDir, 2049, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}
	if res.NumParts() != 3 {
		t.Fatalf("NumParts = %d, want 3", res.NumParts())
	}

	wantCounts := []int{2, 2, 1}
	for i, pf := range res.PartFiles {
		gz, err := os.ReadFile(pf)
		if err != nil {
			t.Fatal(err)
		}
		segs := splitBundlePart(string(gunzip(t, gz)))
		if len(segs) != wantCounts[i] {
			t.Fatalf("part %d has %d files, want %d", i, len(segs), wantCounts[i])
		}
	}

	// 文件名递增 part-0.gz / part-1.gz / part-2.gz。
	for i, pf := range res.PartFiles {
		if filepath.Base(pf) != "part-"+itoa(i)+".gz" {
			t.Fatalf("part %d name = %s, want part-%d.gz", i, filepath.Base(pf), i)
		}
	}
}

// TestPackShaMatchesGzipContent 校验 PartShas = part-i.gz 内容的 sha256（hex 小写），与上传契约 contentSha256 一致。
func TestPackShaMatchesGzipContent(t *testing.T) {
	dir := t.TempDir()
	partsDir := filepath.Join(dir, "parts")
	if err := os.MkdirAll(partsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	contents := map[string]string{
		"a.jsonl": strings.Repeat("a", 1500),
		"b.jsonl": strings.Repeat("b", 1500),
	}
	files := writeFiles(t, dir, contents)

	// 小 partMax 强制多片，验证每片各自 sha。
	res, err := packFiles(files, partsDir, 1000, nil)
	if err != nil {
		t.Fatalf("packFiles: %v", err)
	}
	if res.NumParts() < 2 {
		t.Fatalf("NumParts = %d, want >=2", res.NumParts())
	}

	for i, pf := range res.PartFiles {
		raw, err := os.ReadFile(pf)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		want := hex.EncodeToString(sum[:])
		if res.PartShas[i] != want {
			t.Fatalf("part %d sha = %s, want %s", i, res.PartShas[i], want)
		}
		// 同时核 hex 为小写。
		if res.PartShas[i] != strings.ToLower(res.PartShas[i]) {
			t.Fatalf("part %d sha not lowercase: %s", i, res.PartShas[i])
		}
	}
}

// TestPackProgressEvery500 校验进度回调每 500 个会话触发一次。
func TestPackProgressEvery500(t *testing.T) {
	dir := t.TempDir()
	partsDir := filepath.Join(dir, "parts")
	if err := os.MkdirAll(partsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	contents := map[string]string{}
	for i := 0; i < 1100; i++ {
		contents["f"+itoa(i)+".jsonl"] = "x"
	}
	files := writeFiles(t, dir, contents)

	var calls []int
	progress := func(cnt, total int) { calls = append(calls, cnt) }

	if _, err := packFiles(files, partsDir, 1<<30, progress); err != nil {
		t.Fatalf("packFiles: %v", err)
	}

	want := []int{500, 1000}
	if len(calls) != len(want) {
		t.Fatalf("progress calls = %v, want %v", calls, want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Fatalf("progress[%d] = %d, want %d", i, calls[i], want[i])
		}
	}
}

// TestScanSessions 校验扫描只收两个根目录下非空 *.jsonl，跳过空文件/非 jsonl/无关目录。
func TestScanSessions(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude", "projects", "proj-a")
	codexDir := filepath.Join(home, ".codex", "sessions", "2026", "06")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(codexDir, 0o700); err != nil {
		t.Fatal(err)
	}

	mustWrite := func(p, body string) {
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 命中：非空 jsonl。
	mustWrite(filepath.Join(claudeDir, "s1.jsonl"), `{"k":1}`)
	mustWrite(filepath.Join(codexDir, "s2.jsonl"), `{"k":2}`)
	// 跳过：空 jsonl。
	mustWrite(filepath.Join(claudeDir, "empty.jsonl"), ``)
	// 跳过：非 jsonl。
	mustWrite(filepath.Join(claudeDir, "note.txt"), `hello`)
	// 跳过：无关目录（不在两根之下）。
	otherDir := filepath.Join(home, ".other")
	if err := os.MkdirAll(otherDir, 0o700); err != nil {
		t.Fatal(err)
	}
	mustWrite(filepath.Join(otherDir, "x.jsonl"), `{"k":3}`)

	got, err := scanSessions(home)
	if err != nil {
		t.Fatalf("scanSessions: %v", err)
	}

	want := []string{
		filepath.Join(claudeDir, "s1.jsonl"),
		filepath.Join(codexDir, "s2.jsonl"),
	}
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

// TestItoa 校验无依赖 itoa 与预期一致（含 0 / 多位）。
func TestItoa(t *testing.T) {
	cases := map[int]string{0: "0", 7: "7", 42: "42", 1000: "1000", 16777216: "16777216"}
	for in, want := range cases {
		if got := itoa(in); got != want {
			t.Fatalf("itoa(%d) = %s, want %s", in, got, want)
		}
	}
}
