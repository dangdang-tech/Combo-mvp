package main

import (
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// makeParts 在临时目录造 n 个真实 gzip 分片，返回 PackResult。
func makeParts(t *testing.T, n int) (*PackResult, string) {
	t.Helper()
	dir := t.TempDir()
	res := &PackResult{}
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, partName(i))
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		gz := gzip.NewWriter(f)
		gz.Write([]byte("payload-" + itoa(i)))
		gz.Close()
		f.Close()
		res.PartFiles = append(res.PartFiles, p)
		res.PartShas = append(res.PartShas, "deadbeef")
	}
	return res, dir
}

// TestUploadAllContextCancel 校验：ctx 取消 → uploadAll 立即返回 context.Canceled，在途请求被中断。
//
// 服务端 handler 挂起直到「客户端请求 ctx 取消（连接断）」或「测试结束 teardown」二者其一——
// teardown 通道保证 srv.Close 不会因挂起的 handler 而卡死（与被测逻辑无关，仅是测试自身的收尾）。
func TestUploadAllContextCancel(t *testing.T) {
	teardown := make(chan struct{})
	var inFlight int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&inFlight, 1)
		select {
		case <-r.Context().Done(): // 客户端取消 → 连接断 → 请求 ctx 取消（被测的中断路径）。
		case <-teardown: // 测试收尾兜底，防止 srv.Close 卡在挂起 handler 上。
		}
	}))
	defer srv.Close()
	defer close(teardown)

	res, _ := makeParts(t, 8)
	cfg := uploadConfig{Base: srv.URL, PairID: "p", Code: "c", Source: "mixed", Jobs: 4, NumParts: 8}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// 200ms 后模拟 Ctrl+C 取消。
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()

	start := time.Now()
	err := uploadAll(ctx, cfg, res, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error on cancel, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	// 应在取消后很快返回（远小于 600s 超时），证明在途请求随 ctx 中断、worker pool 立即收敛。
	if elapsed > 5*time.Second {
		t.Fatalf("uploadAll took %v after cancel, expected prompt return", elapsed)
	}
}

// TestUploadAllFailurePropagates 校验：某片持续 500（重试尽）→ 返回 uploadFailure，带服务端返回体摘要、取消其余。
func TestUploadAllFailurePropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte("server boom detail body"))
	}))
	defer srv.Close()

	res, _ := makeParts(t, 3)
	cfg := uploadConfig{Base: srv.URL, PairID: "p", Code: "c", Source: "mixed", Jobs: 2, NumParts: 3}

	err := uploadAll(context.Background(), cfg, res, nil)
	if err == nil {
		t.Fatal("expected failure, got nil")
	}
	var uf *uploadFailure
	if !errors.As(err, &uf) {
		t.Fatalf("expected *uploadFailure, got %T: %v", err, err)
	}
	if uf.status != 500 {
		t.Fatalf("status = %d, want 500", uf.status)
	}
	if uf.bodySnip == "" {
		t.Fatal("expected non-empty server body snippet")
	}
}
