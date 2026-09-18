package filecontent

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestSafeContentTypeDowngradesActiveContent(t *testing.T) {
	tests := []struct {
		contentType string
		want        string
	}{
		{contentType: "text/html; charset=utf-8", want: "text/plain; charset=utf-8"},
		{contentType: "application/javascript", want: "text/plain; charset=utf-8"},
		{contentType: "image/svg+xml", want: "text/plain; charset=utf-8"},
		{contentType: "application/pdf", want: "application/pdf"},
	}
	for _, tt := range tests {
		if got := safeContentType(tt.contentType); got != tt.want {
			t.Fatalf("safeContentType(%q) = %q, want %q", tt.contentType, got, tt.want)
		}
	}
}

func TestBuildContentDispositionDefaultsToAttachment(t *testing.T) {
	got := buildContentDisposition("report.html", false)
	want := `attachment; filename="report.html"; filename*=UTF-8''report.html`
	if got != want {
		t.Fatalf("unexpected disposition: got %q want %q", got, want)
	}
}

func TestETagFromSHA256(t *testing.T) {
	if got := ETag(""); got != "" {
		t.Fatalf("ETag(\"\") = %q, want empty", got)
	}
	if got := ETag("ABC123"); got != `"abc123"` {
		t.Fatalf("ETag = %q, want quoted lowercase", got)
	}
}

func TestNotModifiedMatchesStrongETag(t *testing.T) {
	etag := ETag("abc123")
	if notModified("", etag) {
		t.Fatal("empty If-None-Match must not match")
	}
	if !notModified(`"abc123"`, etag) {
		t.Fatal("exact strong ETag must match")
	}
	if !notModified(`W/"abc123"`, etag) {
		t.Fatal("weak ETag with same value must match")
	}
	if !notModified(`"other", "abc123"`, etag) {
		t.Fatal("list containing matching ETag must match")
	}
	if notModified(`"other"`, etag) {
		t.Fatal("unrelated ETag must not match")
	}
}

func TestWriteCacheHeadersVaryAndMaxAge(t *testing.T) {
	gin.SetMode(gin.TestMode)
	newContext := func() *gin.Context {
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)
		return c
	}

	c := newContext()
	writeCacheHeaders(c, "upload", false)
	if got := c.Writer.Header().Get("Cache-Control"); got != "private, max-age=86400" {
		t.Fatalf("upload private Cache-Control = %q", got)
	}
	if got := c.Writer.Header().Get("Vary"); got != "Authorization" {
		t.Fatalf("upload private Vary = %q", got)
	}

	c = newContext()
	writeCacheHeaders(c, "generated_image", true)
	if got := c.Writer.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("generated public Cache-Control = %q", got)
	}
	if got := c.Writer.Header().Get("Vary"); got != "" {
		t.Fatalf("public response must not Vary, got %q", got)
	}
}
