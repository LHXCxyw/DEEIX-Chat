package conversation

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	app "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/token"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

func TestAgentCapabilitiesAuthenticatedEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	group := engine.Group("/api/v1", middleware.AuthMiddleware("test-secret", nil))
	NewModule(&Handler{service: &app.Service{}}).RegisterRoutes(group, middleware.NewFeatureGate(config.NewRuntime(config.Config{})))
	secret, err := token.GenerateWithClaims(token.GenerateClaimsInput{Secret: "test-secret", UserID: 1, TokenType: "access", TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	for _, authenticated := range []bool{false, true} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/runtime/agent-capabilities", nil)
		if authenticated {
			req.Header.Set("Authorization", "Bearer "+secret)
		}
		res := httptest.NewRecorder()
		engine.ServeHTTP(res, req)
		if !authenticated {
			if res.Code != http.StatusUnauthorized {
				t.Fatalf("未认证请求: %d", res.Code)
			}
			continue
		}
		if res.Code != http.StatusOK || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("响应错误: %d %s", res.Code, res.Body.String())
		}
		var body struct {
			Data app.AgentCapabilities `json:"data"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Data.Browser.Ready || body.Data.Browser.Code != "browser_execution_not_deployed" || body.Data.Browser.Reason == "" {
			t.Fatalf("错误宣称浏览器可用: %+v", body.Data.Browser)
		}
	}
}
