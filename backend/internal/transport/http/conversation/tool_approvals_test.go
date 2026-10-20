package conversation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	app "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/token"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

type approvalHTTPRepo struct {
	repository.ToolApprovalRepository
	user uint
	item repository.ToolApproval
}

func (r *approvalHTTPRepo) ListToolApprovals(_ context.Context, user uint) ([]repository.ToolApproval, error) {
	r.user = user
	return []repository.ToolApproval{r.item}, nil
}

func TestToolApprovalsAuthenticatedOwnerDisplay(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &approvalHTTPRepo{item: repository.ToolApproval{ID: "approval", UserID: 1, ConversationID: 7, ConversationPublicID: "public-chat", RunID: "not-in-visible-messages", Mode: "manual", Status: "pending", ArgumentsJSON: `{"path":"file.txt","nested":[{"api_key":"hidden-secret","password":"hidden-password"}],"headers":{"Authorization":"hidden-auth"}}`, ParametersHash: "bound-hash"}}
	service := &app.Service{}
	service.SetToolApprovalDependencies(repo, nil, nil, nil)
	engine := gin.New()
	group := engine.Group("/api/v1", middleware.AuthMiddleware("test-secret", nil))
	NewModule(&Handler{service: service}).RegisterRoutes(group, middleware.NewFeatureGate(config.NewRuntime(config.Config{})))
	for _, user := range []uint{0, 1, 2} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/tool-approvals", nil)
		if user != 0 {
			access, err := token.GenerateWithClaims(token.GenerateClaimsInput{Secret: "test-secret", UserID: user, TokenType: "access", TTL: time.Minute})
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+access)
		}
		res := httptest.NewRecorder()
		engine.ServeHTTP(res, req)
		if user == 0 {
			if res.Code != http.StatusUnauthorized {
				t.Fatalf("未认证响应: %d", res.Code)
			}
			continue
		}
		if res.Code != http.StatusOK || repo.user != user || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("owner响应错误: %d %s", res.Code, res.Body.String())
		}
		var body struct {
			Data []repository.ToolApproval `json:"data"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if user == 2 {
			if len(body.Data) != 0 {
				t.Fatal("泄露其他用户审批")
			}
			continue
		}
		if len(body.Data) != 1 || body.Data[0].ConversationPublicID != "public-chat" || body.Data[0].ParametersHash != "bound-hash" {
			t.Fatalf("展示映射错误: %s", res.Body.String())
		}
		for _, secret := range []string{"hidden-secret", "hidden-password", "hidden-auth"} {
			if strings.Contains(res.Body.String(), secret) {
				t.Fatal("响应泄露秘密字段")
			}
		}
	}
	if !strings.Contains(repo.item.ArgumentsJSON, "hidden-secret") {
		t.Fatal("展示脱敏修改了原始审批参数")
	}
}
