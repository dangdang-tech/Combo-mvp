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
)

// BundleSentinel 分隔符——必须与 session-parse.ts BUNDLE_SENTINEL 字节一致。
// worker 端按 (BundleSentinel + "\n") split 还原每个文件原文。
const BundleSentinel = "__AGORA_FILE_BOUNDARY__"

// scanRoots 扫描的根目录（相对 $HOME）。与 connect-script.ts 一致：
//
//	$HOME/.claude/projects 与 $HOME/.codex/sessions 下所有非空 *.jsonl。
var scanRoots = []string{
	filepath.Join(".claude", "projects"),
	filepath.Join(".codex", "sessions"),
}

// scanSessions 在 home 下递归查找两个根目录里的所有非空 *.jsonl 文件，返回绝对路径列表。
//
// 口径与 shell `find ROOT -type f -name '*.jsonl' -size +0c`：
//   - 只收普通文件（跳目录/符号链接目标判定按 os.Lstat 的常规文件位）。
//   - 只收 *.jsonl。
//   - 只收非空文件（size > 0）。
//
// 不可达的根目录直接跳过（与 `[ -d ROOT ] || continue` 一致），扫描中的读错误忽略不致命。
func scanSessions(home string) ([]string, error) {
	var files []string
	for _, rel := range scanRoots {
		root := filepath.Join(home, rel)
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			continue // 根目录不存在/不可读：跳过（等价 `[ -d ROOT ] || continue`）。
		}
		walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil // 子树读错误：忽略该条目，继续走（容错，不整体失败）。
			}
			if d.IsDir() {
				return nil
			}
			if !d.Type().IsRegular() {
				return nil // 非普通文件（符号链接/设备等）跳过。
			}
			if !strings.HasSuffix(d.Name(), ".jsonl") {
				return nil
			}
			fi, statErr := d.Info()
			if statErr != nil || fi.Size() <= 0 {
				return nil // 空文件（-size +0c 要求 > 0）或不可 stat：跳过。
			}
			files = append(files, path)
			return nil
		})
		if walkErr != nil {
			return nil, walkErr
		}
	}
	// 稳定排序：保证分片划分可复现（shell 的 find 顺序不保证，但稳定排序更利于幂等/调试）。
	sort.Strings(files)
	return files, nil
}

// PackResult 打包产物：分片文件目录下的 part-i.gz 列表及其 sha256（hex 小写）。
type PackResult struct {
	// PartFiles 已 flush 的分片绝对路径（part-0.gz, part-1.gz, …），有序。
	PartFiles []string
	// PartShas 与 PartFiles 一一对应的 gzip 内容 sha256（hex 小写）。
	PartShas []string
}

// NumParts 分片数 N。
func (r *PackResult) NumParts() int { return len(r.PartFiles) }

// progressFn 打包进度回调（每处理若干个会话调用一次；cnt=已处理，total=总数）。
type progressFn func(cnt, total int)

// packFiles 按契约把多个文件整文件打包成 gzip 分片，写入 partsDir。
//
// 字节精确契约（真源 session-parse.ts / connect-script.ts）：
//   - 每个文件追加到当前缓冲：[]byte(BundleSentinel+"\n") + 文件原始字节 + []byte("\n")。
//   - 当「当前缓冲未压缩字节」≥ partMax 即 flush：把缓冲 gzip 成 part-i.gz（i 从 0 起），缓冲清空。
//   - 末尾若缓冲非空再 flush 一片。只切整文件、不跨片切单文件。
//
// total 用于进度回调；progress 每 500 个会话回调一次（cnt 为已处理累计）。
func packFiles(files []string, partsDir string, partMax int, progress progressFn) (*PackResult, error) {
	res := &PackResult{}
	var buf bytes.Buffer
	part := 0

	sentinelLine := []byte(BundleSentinel + "\n")
	newline := []byte("\n")

	flush := func() error {
		sha, err := writeGzipPart(buf.Bytes(), partsDir, part)
		if err != nil {
			return err
		}
		res.PartFiles = append(res.PartFiles, filepath.Join(partsDir, partName(part)))
		res.PartShas = append(res.PartShas, sha)
		buf.Reset()
		part++
		return nil
	}

	cnt := 0
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			// 单文件读失败：跳过（容错，不整体失败；等价 shell `cat ... 2>/dev/null` 静默）。
			continue
		}
		buf.Write(sentinelLine)
		buf.Write(raw)
		buf.Write(newline)
		cnt++
		if progress != nil && cnt%500 == 0 {
			progress(cnt, len(files))
		}
		if buf.Len() >= partMax {
			if err := flush(); err != nil {
				return nil, err
			}
		}
	}
	// 末尾非空再 flush 一片。
	if buf.Len() > 0 {
		if err := flush(); err != nil {
			return nil, err
		}
	}
	return res, nil
}

// partName 分片文件名 part-i.gz。
func partName(i int) string {
	return "part-" + itoa(i) + ".gz"
}

// writeGzipPart 把 raw 字节 gzip 后写入 partsDir/part-i.gz，返回 gzip 内容的 sha256（hex 小写）。
func writeGzipPart(raw []byte, partsDir string, i int) (string, error) {
	path := filepath.Join(partsDir, partName(i))
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	// 同时算压缩后内容的 sha256（上传契约 contentSha256 = part-i.gz 内容的 sha256）。
	h := sha256.New()
	mw := io.MultiWriter(f, h)
	gz := gzip.NewWriter(mw)
	if _, err := gz.Write(raw); err != nil {
		gz.Close()
		f.Close()
		return "", err
	}
	if err := gz.Close(); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// sha256Hex 算字节内容的 sha256（hex 小写）。
func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// itoa 无依赖整数转十进制字符串（避免在热路径 import strconv 仅为此）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
