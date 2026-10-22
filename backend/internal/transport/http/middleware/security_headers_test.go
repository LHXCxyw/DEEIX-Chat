package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func runSecurityHeaders(t *testing.T, frameAncestors string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	_, router := gin.CreateTestContext(recorder)
	router.Use(SecurityHeaders(frameAncestors))
	router.GET("/", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestSecurityHeadersDeniesFramingByDefault(t *testing.T) {
	for _, value := range []string{"", "none", "'none'", "https://a.example.com; script-src *", "https://a.example.com\nX-Evil: 1", "'self' `https://a.example.com`"} {
		recorder := runSecurityHeaders(t, value)
		if got := recorder.Header().Get("X-Frame-Options"); got != "DENY" {
			t.Fatalf("frameAncestors %q: expected DENY, got %q", value, got)
		}
		if got := recorder.Header().Get("Content-Security-Policy"); got != "" {
			t.Fatalf("frameAncestors %q: expected no CSP, got %q", value, got)
		}
	}
}

func TestSecurityHeadersAllowsConfiguredAncestors(t *testing.T) {
	recorder := runSecurityHeaders(t, "'self' https://newapi.example.com")
	if got := recorder.Header().Get("Content-Security-Policy"); got != "frame-ancestors 'self' https://newapi.example.com" {
		t.Fatalf("unexpected CSP %q", got)
	}
	if got := recorder.Header().Get("X-Frame-Options"); got != "" {
		t.Fatalf("allowlisted origins must not send X-Frame-Options, got %q", got)
	}
}

func TestSecurityHeadersSelfOnlyUsesSameOrigin(t *testing.T) {
	recorder := runSecurityHeaders(t, "'self'")
	if got := recorder.Header().Get("X-Frame-Options"); got != "SAMEORIGIN" {
		t.Fatalf("expected SAMEORIGIN, got %q", got)
	}
	if got := recorder.Header().Get("Content-Security-Policy"); got != "frame-ancestors 'self'" {
		t.Fatalf("unexpected CSP %q", got)
	}
}
