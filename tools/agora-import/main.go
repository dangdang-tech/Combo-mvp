// agora-import — Agora 本机对话历史上传器（B-21 引导脚本下载并 exec 之）。
//
// 职责（重活全在此二进制，替代纯 shell 的脆弱并发/取消）：
//
//	扫描 ~/.claude/projects 与 ~/.codex/sessions 的非空 *.jsonl
//	  → 打包成 gzip 分片（按【压缩后大小】收口、超大文件按行切；worker 拆包口径不变）
//	  → 并发上传到 {BASE}/api/v1/import/connect/upload（context 取消 / 信号 / 重试 / 同 host 保留 Authorization 重定向 / 无代理）
//	  → 终端彩色 TUI 进度（上传是进度条）/ 非 TTY 逐行文案 → 清理临时目录 → 退出码。
//
// 隐私文案硬约束：本机读取后【全量上传原文】、云端解析去敏。绝不出现「数据不出本机/仅上传精简/本机解析只传提取后」等字眼。
//
// 仅用 Go 标准库，CGO_ENABLED=0，可交叉编译 darwin/linux × amd64/arm64。
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// 退出码：0 成功；1 用法/扫描/上传失败；130 收到中断信号取消。
const (
	exitOK       = 0
	exitError    = 1
	exitCanceled = 130
)

// 默认值（可被环境变量覆盖）。
const (
	defaultSource = "mixed"
	defaultJobs   = 8
)

func main() {
	os.Exit(run())
}

func run() int {
	// 信号：Ctrl+C(SIGINT) / SIGTERM → ctx 取消 → 所有上传 goroutine 经 req.WithContext(ctx) 立即中断、worker 退出。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rep := newReporter()

	cfg, err := loadConfig()
	if err != nil {
		// 缺必填项 / 非法配置：人话报错 + exit 1。
		rep.failf("%s", err.Error())
		return exitError
	}

	home, err := resolveHome()
	if err != nil {
		rep.failf("找不到你的用户主目录，无法读取对话历史。请回到网页，改用浏览器上传。")
		return exitError
	}

	// 临时分片目录：os.MkdirTemp + defer os.RemoveAll（取消时也清，绝不留孤儿/不往已删路径写）。
	tmpDir, err := os.MkdirTemp("", "agora-import-")
	if err != nil {
		rep.failf("无法创建临时目录，命令行方式用不了。请回到网页，改用浏览器上传。")
		return exitError
	}
	defer os.RemoveAll(tmpDir)
	partsDir := tmpDir + string(os.PathSeparator) + "parts"
	if err := os.MkdirAll(partsDir, 0o700); err != nil {
		rep.failf("无法创建临时目录，命令行方式用不了。请回到网页，改用浏览器上传。")
		return exitError
	}

	// 1. 扫描。
	rep.scanStart()
	files, err := scanSessions(home)
	if err != nil {
		rep.failf("读取对话历史时出错了。请回到网页，改用浏览器上传。")
		return exitError
	}
	if len(files) == 0 {
		rep.failf("没扫到可导入的对话历史。去产生一些历史后再来，或回网页换种导入方式。")
		return exitError
	}

	// 取消检查点（扫描可能很久）。
	if ctx.Err() != nil {
		return exitCanceled
	}

	// 2. 打包（进度条 / 逐行）。
	res, err := packFiles(files, partsDir, func(cnt, total int) { rep.packProgress(cnt, total) })
	if err != nil {
		if ctx.Err() != nil {
			return exitCanceled
		}
		rep.failf("打包对话历史时出错了。请回到网页，改用浏览器上传。")
		return exitError
	}
	if res.NumParts() == 0 {
		rep.failf("没扫到可导入的对话历史。去产生一些历史后再来，或回网页换种导入方式。")
		return exitError
	}

	if ctx.Err() != nil {
		return exitCanceled
	}

	cfg.NumParts = res.NumParts()

	// 3. 并发上传（云端会抹掉隐私信息）。
	rep.uploadStart(cfg.NumParts, cfg.Jobs)
	if err := uploadAll(ctx, cfg, res, func(done, total int) { rep.uploadProgress(done, total) }); err != nil {
		// 信号取消 → 130（不当作错误汇报）。
		if errors.Is(err, context.Canceled) && ctx.Err() != nil {
			rep.failf("已取消上传。")
			return exitCanceled
		}
		// 任一片最终失败：打印服务端返回体摘要（uploadFailure.Error 已含前 300 字节）+ 非零退出。
		rep.failf("上传没能完成（%s）。可回到网页重新生成命令后再试。", err.Error())
		return exitError
	}

	if ctx.Err() != nil {
		return exitCanceled
	}

	rep.success()
	return exitOK
}

// resolveHome 取用户主目录：优先 $HOME，回退 os.UserHomeDir。
func resolveHome() (string, error) {
	if h := os.Getenv("HOME"); h != "" {
		return h, nil
	}
	return os.UserHomeDir()
}

// loadConfig 从环境变量装配上传配置。
//
//	AGORA_BASE     必填，如 https://agora.xxx
//	AGORA_PAIR_ID  必填
//	AGORA_CODE     必填，配对码
//	AGORA_SOURCE   默认 mixed
//	AGORA_JOBS     默认 8
//
// 缺必填项 → 返回人话错误（main 打印后 exit 1）。
func loadConfig() (uploadConfig, error) {
	base := os.Getenv("AGORA_BASE")
	pairID := os.Getenv("AGORA_PAIR_ID")
	code := os.Getenv("AGORA_CODE")

	var missing []string
	if base == "" {
		missing = append(missing, "AGORA_BASE")
	}
	if pairID == "" {
		missing = append(missing, "AGORA_PAIR_ID")
	}
	if code == "" {
		missing = append(missing, "AGORA_CODE")
	}
	if len(missing) > 0 {
		return uploadConfig{}, fmt.Errorf(
			"缺少必要参数（%s），无法连接云端。请回到网页重新生成连接命令。",
			joinComma(missing),
		)
	}

	source := os.Getenv("AGORA_SOURCE")
	if source == "" {
		source = defaultSource
	}

	jobs := parseIntEnv("AGORA_JOBS", defaultJobs)
	if jobs < 1 {
		jobs = defaultJobs
	}

	return uploadConfig{
		Base:   base,
		PairID: pairID,
		Code:   code,
		Source: source,
		Jobs:   jobs,
	}, nil
}

// parseIntEnv 读取一个十进制正整数环境变量；缺失/非法 → def。
func parseIntEnv(name string, def int) int {
	s := os.Getenv(name)
	if s == "" {
		return def
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def // 非纯数字（含负号/空格）→ 回落默认。
		}
		n = n*10 + int(c-'0')
		if n > 1<<40 {
			return def // 溢出保护。
		}
	}
	if n == 0 {
		return def
	}
	return n
}

// joinComma 逗号拼接（避免为此 import strings）。
func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}
