package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// uploadConfig 上传所需的全部参数（来自环境变量，main 装配）。
type uploadConfig struct {
	Base     string // 形如 https://agora.xxx（无尾斜杠）
	PairID   string
	Code     string // 配对码（Authorization: Bearer）
	Source   string // 默认 mixed
	Jobs     int    // 并发路数（默认 8）
	NumParts int    // 分片总数 N
}

// 每片上传超时 600s；失败重试 3 次，退避 1s/2s/3s（与 shell 契约对齐）。
const (
	perPartTimeout = 600 * time.Second
	maxAttempts    = 3
)

// newHTTPClient 构造不走系统代理（等价 curl --noproxy '*'）的 client。
//
// 重定向：跟随 301/302/307/308；同 host 重定向保留 Authorization 重发，跨 host 去掉。
// 注意：标准库 http.Client 默认会在 301/302/303 上把 POST 改成 GET 并丢 body；
// 我们不依赖默认重定向来重放带 body 的 POST——uploadPart 用一次性的请求构造并自行处理
// 重定向到「同 host」时重建带 body 的 POST（见 doWithRedirect）。这里的 client 仅用于单跳。
func newHTTPClient() *http.Client {
	tr := &http.Transport{
		Proxy: nil, // 不走系统/公司代理（curl --noproxy '*'）。
	}
	return &http.Client{
		Transport: tr,
		// 我们自己处理重定向（为了在带 body 的 POST 上保留/剥离 Authorization 并重发），
		// 故这里禁用 client 自动重定向。
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// buildMultipart 把一个 gzip 分片文件读成 multipart/form-data 请求体。
// 文件域名必须是 "file"，文件名 part-{i}.gz。返回 body 字节与 content-type。
func buildMultipart(partPath string, i int) ([]byte, string, error) {
	data, err := os.ReadFile(partPath)
	if err != nil {
		return nil, "", err
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	fw, err := w.CreateFormFile("file", partName(i))
	if err != nil {
		return nil, "", err
	}
	if _, err := fw.Write(data); err != nil {
		return nil, "", err
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return body.Bytes(), w.FormDataContentType(), nil
}

// uploadResult 单片上传结果（失败时带服务端返回体摘要供汇报）。
type uploadResult struct {
	index      int
	err        error
	statusCode int
	bodySnip   string // 失败时服务端返回体前 300 字节（去换行）
}

// uploadAll 并发上传所有分片。任一片重试尽仍失败 → 取消其余、返回该失败（带返回体摘要）。
// ctx 被取消（Ctrl+C / SIGTERM）→ 进行中的请求随 req.WithContext(ctx) 立即中断、worker 退出。
//
// done 进度回调：每成功一片调用一次（done=已完成数，total=N）。
func uploadAll(ctx context.Context, cfg uploadConfig, res *PackResult, done func(doneCount, total int)) error {
	n := res.NumParts()
	if n == 0 {
		return nil
	}
	client := newHTTPClient()

	// worker pool / 信号量：限制并发为 cfg.Jobs。
	jobs := cfg.Jobs
	if jobs < 1 {
		jobs = 1
	}
	if jobs > n {
		jobs = n
	}

	// 子 context：任一片失败即 cancel，连带中断其余在途/未起跑请求（Ctrl+C 经父 ctx 同样下传）。
	upCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// 并发上限信号量（worker pool）。每个分片恰好起一个 task、恰好产一个 result，
	//   故不存在「派发数 ≠ 收集数」的悬挂——所有 task 跑完 wg.Wait 后才关 results、再统一收集。
	sem := make(chan struct{}, jobs)
	results := make(chan uploadResult, n)

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			// 取信号量前先看是否已取消：已取消则直接产「取消」结果，不占并发额度。
			select {
			case <-upCtx.Done():
				results <- uploadResult{index: idx, err: upCtx.Err()}
				return
			case sem <- struct{}{}:
			}
			defer func() { <-sem }()
			// 拿到额度后再确认一次（取消可能发生在排队期间）。
			select {
			case <-upCtx.Done():
				results <- uploadResult{index: idx, err: upCtx.Err()}
				return
			default:
			}
			code, snip, err := uploadPart(upCtx, client, cfg, res, idx)
			results <- uploadResult{index: idx, err: err, statusCode: code, bodySnip: snip}
		}(i)
	}

	// 关闭收集端：所有 task 完成后关 results（task 数 = n，故 results 恰收 n 条，绝不悬挂）。
	go func() {
		wg.Wait()
		close(results)
	}()

	// 收集结果（range 到 results 关闭；首个错误即 cancel 连带中断其余在途请求并快速收敛）。
	var firstErr error
	var firstFail *uploadResult
	completed := 0
	for r := range results {
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
				rc := r
				firstFail = &rc
				cancel() // 取消其余在途/未起跑任务。
			}
			continue
		}
		completed++
		if done != nil {
			done(completed, n)
		}
	}

	if firstErr != nil {
		// 取消（Ctrl+C / SIGTERM）单独识别，交给 main 出 130。
		if errors.Is(firstErr, context.Canceled) && ctx.Err() != nil {
			return firstErr
		}
		if firstFail != nil && firstFail.bodySnip != "" {
			return &uploadFailure{
				index:    firstFail.index,
				status:   firstFail.statusCode,
				bodySnip: firstFail.bodySnip,
				cause:    firstErr,
			}
		}
		return &uploadFailure{
			index:  firstIndexOf(firstFail),
			status: statusOf(firstFail),
			cause:  firstErr,
		}
	}
	return nil
}

func firstIndexOf(f *uploadResult) int {
	if f == nil {
		return -1
	}
	return f.index
}
func statusOf(f *uploadResult) int {
	if f == nil {
		return 0
	}
	return f.statusCode
}

// uploadFailure 终态失败（用于 main 打印服务端返回体摘要 + 非零退出）。
type uploadFailure struct {
	index    int
	status   int
	bodySnip string
	cause    error
}

func (e *uploadFailure) Error() string {
	if e.bodySnip != "" {
		return fmt.Sprintf("分片 %d 上传失败（HTTP %d）：%s", e.index, e.status, e.bodySnip)
	}
	if e.cause != nil {
		return fmt.Sprintf("分片 %d 上传失败：%v", e.index, e.cause)
	}
	return fmt.Sprintf("分片 %d 上传失败（HTTP %d）", e.index, e.status)
}

// uploadPart 上传单个分片：重试 maxAttempts 次，退避 1s/2s/3s，每次单独 600s 超时。
// 返回最后一次的 (statusCode, bodySnippet, error)。成功（2xx）→ error=nil。
func uploadPart(ctx context.Context, client *http.Client, cfg uploadConfig, res *PackResult, idx int) (int, string, error) {
	partPath := res.PartFiles[idx]
	sha := res.PartShas[idx]

	q := url.Values{}
	q.Set("pairId", cfg.PairID)
	q.Set("source", cfg.Source)
	q.Set("partIndex", itoa(idx))
	q.Set("totalParts", itoa(cfg.NumParts))
	q.Set("contentSha256", sha)
	endpoint := strings.TrimRight(cfg.Base, "/") + "/api/v1/import/connect/upload?" + q.Encode()

	idem := "pair-" + cfg.PairID + "-" + itoa(idx) + "-" + sha

	body, contentType, err := buildMultipart(partPath, idx)
	if err != nil {
		return 0, "", err
	}

	var lastStatus int
	var lastSnip string
	var lastErr error

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		// 每片每次尝试单独 600s 超时；ctx 取消则整体中断。
		reqCtx, cancel := context.WithTimeout(ctx, perPartTimeout)
		status, snip, err := doWithRedirect(reqCtx, client, endpoint, contentType, idem, cfg.Code, body)
		cancel()

		if err == nil && status >= 200 && status < 300 {
			return status, "", nil
		}

		// 取消/超时来自父 ctx（Ctrl+C / SIGTERM）：立即放弃、上抛取消，不再退避重试。
		if ctx.Err() != nil {
			return status, snip, ctx.Err()
		}

		lastStatus = status
		lastSnip = snip
		if err != nil {
			lastErr = err
		} else {
			lastErr = fmt.Errorf("HTTP %d", status)
		}

		if attempt < maxAttempts {
			// 指数退避 1s/2s/3s（attempt 即将进入下一轮，退避 attempt 秒）。
			select {
			case <-ctx.Done():
				return lastStatus, lastSnip, ctx.Err()
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}
	}
	return lastStatus, lastSnip, lastErr
}

// doWithRedirect 发一次带 body 的 POST，并手动跟随 301/302/307/308 重定向。
// 同 host 重定向：保留 Authorization 并重发 POST（应对 BASE 是 http 命中 80→443）。
// 跨 host 重定向：不带 Authorization 重发 POST。最多跟随 10 跳，防环。
func doWithRedirect(ctx context.Context, client *http.Client, endpoint, contentType, idem, code string, body []byte) (int, string, error) {
	const maxRedirects = 10
	curURL := endpoint
	authHost := hostOf(endpoint) // 初始请求 host：携带 Authorization 的归属 host。

	for hop := 0; hop <= maxRedirects; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, curURL, bytes.NewReader(body))
		if err != nil {
			return 0, "", err
		}
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("Idempotency-Key", idem)
		// 仅当当前请求 host 与「初始 host」同 host 时携带 Authorization。
		if sameHost(hostOf(curURL), authHost) {
			req.Header.Set("Authorization", "Bearer "+code)
		}

		resp, err := client.Do(req)
		if err != nil {
			return 0, "", err
		}

		// 重定向：301/302/307/308 跟随并重发 POST（client.CheckRedirect 已禁用自动重定向）。
		if isRedirect(resp.StatusCode) {
			loc := resp.Header.Get("Location")
			drainClose(resp.Body)
			if loc == "" {
				return resp.StatusCode, "", nil
			}
			next, err := resolveLocation(curURL, loc)
			if err != nil {
				return resp.StatusCode, "", err
			}
			curURL = next
			continue
		}

		// 终态响应：读返回体摘要（前 300 字节）。
		snippet := readSnippet(resp.Body)
		drainClose(resp.Body)
		return resp.StatusCode, snippet, nil
	}
	return 0, "", errors.New("重定向次数过多")
}

func isRedirect(code int) bool {
	switch code {
	case http.StatusMovedPermanently, // 301
		http.StatusFound,             // 302
		http.StatusTemporaryRedirect, // 307
		http.StatusPermanentRedirect: // 308
		return true
	}
	return false
}

// resolveLocation 把可能为相对路径的 Location 解析为绝对 URL（基于当前 URL）。
func resolveLocation(base, loc string) (string, error) {
	bu, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	lu, err := url.Parse(loc)
	if err != nil {
		return "", err
	}
	return bu.ResolveReference(lu).String(), nil
}

// hostOf 取 URL 的 host（含端口）。解析失败回空串。
func hostOf(u string) string {
	pu, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return pu.Host
}

// sameHost 判同 host（含端口；大小写不敏感）。
func sameHost(a, b string) bool {
	return strings.EqualFold(a, b)
}

// readSnippet 读返回体前 300 字节，换行替空格（便于单行汇报）。
func readSnippet(r io.Reader) string {
	buf := make([]byte, 300)
	n, _ := io.ReadFull(io.LimitReader(r, 300), buf)
	s := string(buf[:n])
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	return strings.TrimSpace(s)
}

// drainClose 排空并关闭 body（复用连接 + 防泄漏）。
func drainClose(rc io.ReadCloser) {
	if rc == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(rc, 1<<16))
	_ = rc.Close()
}
