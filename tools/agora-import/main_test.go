package main

import "testing"

func TestLoadConfigSessionLimit(t *testing.T) {
	t.Setenv("AGORA_BASE", "https://agora.example")
	t.Setenv("AGORA_PAIR_ID", "pair")
	t.Setenv("AGORA_CODE", "code")
	t.Setenv("AGORA_SESSION_LIMIT", "50")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.SessionLimit != 50 {
		t.Fatalf("SessionLimit = %d, want 50", cfg.SessionLimit)
	}
}
