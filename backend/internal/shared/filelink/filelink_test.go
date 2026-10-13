package filelink

import (
	"strings"
	"testing"
	"time"
)

func TestBuildAndVerifyContentURL(t *testing.T) {
	now := time.Now()
	url := BuildContentURL("https://api.example.com/", "secret", 42, "file-1", now)
	if url == "" {
		t.Fatalf("expected signed url when base url and secret configured")
	}
	if !strings.HasPrefix(url, "https://api.example.com/api/v1/files/file-1/signed-content?") {
		t.Fatalf("unexpected url: %s", url)
	}
	if !strings.Contains(url, "user_id=42") || !strings.Contains(url, "signature=") {
		t.Fatalf("url missing query params: %s", url)
	}

	// 从 URL 里拆出查询参数做校验（避免依赖 net/http 解析器重复实现）。
	query := url[strings.Index(url, "?")+1:]
	fields := map[string]string{}
	for _, pair := range strings.Split(query, "&") {
		kv := strings.SplitN(pair, "=", 2)
		fields[kv[0]] = kv[1]
	}
	userID, err := Verify("secret", fields["user_id"], "file-1", fields["expires"], fields["signature"], now)
	if err != nil {
		t.Fatalf("verify fresh signature: %v", err)
	}
	if userID != 42 {
		t.Fatalf("expected user 42, got %d", userID)
	}

	// 过期签名应被拒绝。
	if _, err := Verify("secret", fields["user_id"], "file-1", fields["expires"], fields["signature"], now.Add(2*time.Hour)); err == nil {
		t.Fatalf("expected expired signature to be rejected")
	}
	// 篡改签名应被拒绝。
	if _, err := Verify("secret", fields["user_id"], "file-1", fields["expires"], "deadbeef", now); err == nil {
		t.Fatalf("expected tampered signature to be rejected")
	}
}

func TestBuildContentURLRequiresConfiguration(t *testing.T) {
	if url := BuildContentURL("", "secret", 1, "file-1", time.Now()); url != "" {
		t.Fatalf("expected empty url without base url, got %s", url)
	}
	if url := BuildContentURL("https://api.example.com", "", 1, "file-1", time.Now()); url != "" {
		t.Fatalf("expected empty url without secret, got %s", url)
	}
}
