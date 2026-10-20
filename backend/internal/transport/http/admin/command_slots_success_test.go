package admin

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appadmin "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/admin"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/gin-gonic/gin"
)

type successfulSlotRecovery struct{ released bool }

func (s *successfulSlotRecovery) ListOccupiedCommandSlots(context.Context) ([]admission.CommandSlotSnapshot, error) {
	return []admission.CommandSlotSnapshot{{Slot: 0, OwnerUserID: 1, OperationID: "op", Token: "secret-token", LeaseUntil: time.Now().Add(-time.Hour).Truncate(time.Hour), OperationStatus: "uncertain", OperationRevision: 4, OperationRunID: "run", Identity: runtime.ContainerIdentity{ID: "container", Owner: "owner", TaskID: "run", OperationID: "op"}}}, nil
}
func (s *successfulSlotRecovery) BindCommandContainer(context.Context, admission.Lease, uint64, runtime.ContainerIdentity) error {
	return nil
}
func (s *successfulSlotRecovery) ReleaseRecoveredCommandSlot(context.Context, admission.CommandSlotSnapshot) error {
	s.released = true
	return nil
}
func (s *successfulSlotRecovery) RecoverContainer(context.Context, runtime.ContainerIdentity) error {
	return nil
}

func TestRecoverCommandSlotSuccess200(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := &successfulSlotRecovery{}
	service := appadmin.NewCommandSlotService(store, "key", store)
	views, err := service.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	input := appadmin.RecoverCommandSlotInput{OwnerUserID: 1, OperationID: "op", OperationRevision: 4, Snapshot: views[0].Snapshot}
	body, _ := json.Marshal(input)
	h := NewHandler(nil)
	h.SetCommandSlotService(service)
	engine := gin.New()
	engine.POST("/slots/:slot/recover", h.RecoverCommandSlot)
	req := httptest.NewRequest("POST", "/slots/0/recover", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	if rec.Code != 200 || !store.released || !strings.Contains(rec.Body.String(), `"recovery":"released"`) || strings.Contains(rec.Body.String(), "secret-token") {
		t.Fatalf("恢复成功响应错误: %d %s", rec.Code, rec.Body.String())
	}
}
