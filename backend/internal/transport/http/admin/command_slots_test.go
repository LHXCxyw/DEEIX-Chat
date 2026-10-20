package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appadmin "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/admin"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/token"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

type commandSlotObserver struct{ err error }

func (o *commandSlotObserver) ListOccupiedCommandSlots(context.Context) ([]admission.CommandSlotSnapshot, error) {
	return []admission.CommandSlotSnapshot{{Slot: 0, OwnerUserID: 1, OperationID: "op", Token: "hidden-token", LeaseUntil: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), OperationStatus: "uncertain", OperationRevision: 4}}, o.err
}

func TestCommandSlotAdminRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	observer := &commandSlotObserver{}
	service := appadmin.NewCommandSlotService(observer, "snapshot-key")
	handler := NewHandler(nil)
	handler.SetCommandSlotService(service)
	engine := gin.New()
	group := engine.Group("/admin", middleware.AuthMiddleware("jwt-key", nil), middleware.AdminOnly())
	NewModule(handler).RegisterRoutes(group, middleware.FeatureGate{})
	makeToken := func(role string) string {
		value, err := token.GenerateWithClaims(token.GenerateClaimsInput{Secret: "jwt-key", UserID: 1, Role: role, TTL: time.Hour})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	adminToken, userToken := makeToken("admin"), makeToken("user")
	call := func(method, path, body, auth string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		return rec
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		path := "/admin/agent-command-slots"
		if method == http.MethodPost {
			path += "/0/recover"
		}
		if rec := call(method, path, "{}", ""); rec.Code != 401 {
			t.Fatalf("未认证: %d %s", rec.Code, rec.Body.String())
		}
		if rec := call(method, path, "{}", userToken); rec.Code != 403 {
			t.Fatalf("非管理员: %d", rec.Code)
		}
	}
	rec := call("GET", "/admin/agent-command-slots", "", adminToken)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "hidden-token") || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("列表: %d %s", rec.Code, rec.Body.String())
	}
	views, err := service.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	input := appadmin.RecoverCommandSlotInput{OwnerUserID: 1, OperationID: "op", OperationRevision: 4, Snapshot: views[0].Snapshot}
	body, _ := json.Marshal(input)
	rec = call("POST", "/admin/agent-command-slots/0/recover", string(body), adminToken)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), `"released":false`) || !strings.Contains(rec.Body.String(), "trusted_container_identity_missing") {
		t.Fatalf("保守阻断: %d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []string{`{}`, `{"token":"forged"}`, string(body) + ` {}`, `{"owner_user_id":1}`} {
		if rec := call("POST", "/admin/agent-command-slots/0/recover", body, adminToken); rec.Code != 400 {
			t.Fatalf("错误输入: %d %s", rec.Code, rec.Body.String())
		}
	}
	input.OwnerUserID = 2
	body, _ = json.Marshal(input)
	if rec := call("POST", "/admin/agent-command-slots/0/recover", string(body), adminToken); rec.Code != 409 {
		t.Fatalf("owner不匹配: %d", rec.Code)
	}
	observer.err = errors.New("database unavailable")
	if rec := call("GET", "/admin/agent-command-slots", "", adminToken); rec.Code != 500 {
		t.Fatalf("数据库失败: %d", rec.Code)
	}
}
