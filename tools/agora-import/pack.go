package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// BundleSentinel 分隔符——必须与 session-parse.ts BUNDLE_SENTINEL 字节一致。
// worker 端按 (BundleSentinel + "\n") split 还原每条记录原文。
const BundleSentinel = "__AGORA_FILE_BOUNDARY__"

// 分片大小策略（修 413）：真正的约束不是「未压缩多大」，而是【每片 gzip 压缩后那一个 POST 请求体】
// 必须 ≤ 链路最窄的 nginx 限额（当前 web 容器 nginx = 32m）。压缩率不可控（带图片的会话几乎压不动），
// 所以改成按【压缩后大小】收口，并对「超大单文件」按行切：
//   - partTargetCompressed：当前分片压缩后达到此值即收口、另起一片。
//   - recordMax：单条写入记录（一个文件、或一个文件按行切出的一段）的未压缩上限。
//     单条记录最坏（完全不可压）也只贡献约 recordMax 字节，故一片压缩后 ≤ partTargetCompressed + recordMax
//     ≈ 22 MiB，稳低于 32m。超大单文件被按行切成多条记录 → worker 仍按 sentinel 拆包（口径不变），
//     只是该超大会话在「提取」步会被拆成多个会话单元（对极端大的会话可接受的折中）。
const (
	recordMax            = 6 << 20  // 6 MiB：单条记录未压缩上限。
	partTargetCompressed = 16 << 20 // 16 MiB：分片压缩后达标即收口。
)

// scanRoots 扫描的根目录（相对 $HOME）。与 connect-script.ts 一致：
//
//	$HOME/.claude/projects 与 $HOME/.codex/sessions 下所有非空 *.jsonl。
var scanRoots = []string{
	filepath.Join(".claude", "projects"),
	filepath.Join(".codex", "sessions"),
}

// scanSessions 在 home 下递归查找两个根目录里的所有非空 *.jsonl 文件，返回绝对路径列表。
//
// 口径与 shell `find ROOT -type f -name '*.jsonl' -size +0c`：只收普通文件、*.jsonl、非空文件。
// 不可达的根目录直接跳过；扫描中的读错误忽略不致命。
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
				return nil // 空文件或不可 stat：跳过。
			}
			files = append(files, path)
			return nil
		})
		if walkErr != nil {
			return nil, walkErr
		}
	}
	// 稳定排序：保证分片划分可复现。
	sort.Strings(files)
	return files, nil
}

// PackResult 打包产物：分片文件 part-i.gz 列表及其 sha256（hex 小写）。
type PackResult struct {
	PartFiles []string
	PartShas  []string
}

// NumParts 分片数 N。
func (r *PackResult) NumParts() int { return len(r.PartFiles) }

// progressFn 打包进度回调（每处理一个会话调用一次；cnt=已处理，total=总数）。
type progressFn func(cnt, total int)

// packFiles 把多个文件打包成 gzip 分片，写入 partsDir，每片【压缩后】≤ ~22MiB（< 32m）。
//
// 字节格式（worker splitBundlePart 口径不变）：每条记录写 BundleSentinel+"\n" + 记录原文 + "\n"。
//   - 整文件 ≤ recordMax → 一条记录（与旧版「整文件」字节一致）。
//   - 文件 > recordMax → 按行边界切成多条记录（worker 把每条当一个会话片段）。
func packFiles(files []string, partsDir string, progress progressFn) (*PackResult, error) {
	res := &PackResult{}
	pb := &partBuilder{dir: partsDir, res: res}

	cnt := 0
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			continue // 单文件读失败：跳过（容错，等价 shell `cat ... 2>/dev/null`）。
		}
		for _, chunk := range splitIntoChunks(raw, recordMax) {
			if len(chunk) > recordMax {
				// 超大单行（一行就超 recordMax）：让它独占一片，不连累相邻数据。
				if err := pb.finalizeIfOpen(); err != nil {
					return nil, err
				}
				if err := pb.addChunk(chunk); err != nil {
					return nil, err
				}
				if err := pb.finalizeIfOpen(); err != nil {
					return nil, err
				}
			} else if err := pb.addChunk(chunk); err != nil {
				return nil, err
			}
		}
		cnt++
		if progress != nil {
			progress(cnt, len(files))
		}
	}
	if err := pb.finalizeIfOpen(); err != nil {
		return nil, err
	}
	return res, nil
}

// splitIntoChunks 把 raw 按行边界切成每段 ≤ max 的若干段（各段含自己的行尾换行）。
// 单行超过 max → 该行整体成一段（行内无法切，best effort）。
func splitIntoChunks(raw []byte, max int) [][]byte {
	if len(raw) <= max {
		return [][]byte{raw}
	}
	var chunks [][]byte
	start := 0
	for start < len(raw) {
		if len(raw)-start <= max {
			chunks = append(chunks, raw[start:])
			break
		}
		var end int
		if nl := bytes.LastIndexByte(raw[start:start+max], '\n'); nl >= 0 {
			end = start + nl + 1 // 切到行尾换行之后。
		} else if next := bytes.IndexByte(raw[start+max:], '\n'); next >= 0 {
			end = start + max + next + 1 // 窗口内无换行（单行超 max）：取到下一个换行。
		} else {
			chunks = append(chunks, raw[start:]) // 末尾一整行无换行。
			break
		}
		chunks = append(chunks, raw[start:end])
		start = end
	}
	return chunks
}

// partBuilder 流式把记录写进当前分片的 gzip 流；压缩后达标即收口、另起一片。
// 通过 gz.Flush() 把已压缩字节推给 countingWriter，从而能近实时观察「压缩后大小」做切片决策。
type partBuilder struct {
	dir  string
	next int
	res  *PackResult
	// 当前打开的分片（nil = 无）：
	f   *os.File
	gz  *gzip.Writer
	hsh hash.Hash
	cw  *countingWriter
}

var (
	sentinelLine = []byte(BundleSentinel + "\n")
	newlineByte  = []byte("\n")
)

func (b *partBuilder) ensureOpen() error {
	if b.f != nil {
		return nil
	}
	f, err := os.Create(filepath.Join(b.dir, partName(b.next)))
	if err != nil {
		return err
	}
	b.f, b.hsh, b.cw = f, sha256.New(), &countingWriter{}
	// 同时写文件、算 sha256（上传契约 contentSha256 = 压缩后内容的 sha256）、数压缩后字节。
	b.gz = gzip.NewWriter(io.MultiWriter(f, b.hsh, b.cw))
	return nil
}

// addChunk 写入一条记录（sentinel + chunk + 换行）；写完压缩后达标即收口。
func (b *partBuilder) addChunk(chunk []byte) error {
	if err := b.ensureOpen(); err != nil {
		return err
	}
	for _, p := range [][]byte{sentinelLine, chunk, newlineByte} {
		if _, err := b.gz.Write(p); err != nil {
			return err
		}
	}
	if err := b.gz.Flush(); err != nil { // 把压缩字节推给计数器。
		return err
	}
	if b.cw.n >= partTargetCompressed {
		return b.finalize()
	}
	return nil
}

func (b *partBuilder) finalizeIfOpen() error {
	if b.f == nil {
		return nil
	}
	return b.finalize()
}

func (b *partBuilder) finalize() error {
	if err := b.gz.Close(); err != nil {
		b.f.Close()
		return err
	}
	if err := b.f.Close(); err != nil {
		return err
	}
	b.res.PartFiles = append(b.res.PartFiles, filepath.Join(b.dir, partName(b.next)))
	b.res.PartShas = append(b.res.PartShas, hex.EncodeToString(b.hsh.Sum(nil)))
	b.next++
	b.f, b.gz, b.hsh, b.cw = nil, nil, nil, nil
	return nil
}

// countingWriter 只数写入字节数（用于观察压缩后大小）。
type countingWriter struct{ n int }

func (w *countingWriter) Write(p []byte) (int, error) { w.n += len(p); return len(p), nil }

// partName 分片文件名 part-i.gz。
func partName(i int) string { return "part-" + itoa(i) + ".gz" }

// sha256Hex 算字节内容的 sha256（hex 小写）。
func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// itoa 无依赖整数转十进制字符串。
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
