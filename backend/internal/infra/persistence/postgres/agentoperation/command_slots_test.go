package agentoperation

import (
	"context"
	"errors"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"strings"
	"testing"
	"time"
)

func TestCommandSlotBindingAndRecoveryCAS(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	if err := db.AutoMigrate(&models.AgentOperation{}, &models.AgentCommandSlot{}); err != nil {
		t.Fatal(err)
	}
	repo := NewRepo(db)
	ctx := context.Background()
	future := time.Now().UTC().Add(time.Hour)
	past := time.Now().UTC().Add(-time.Hour)
	op := models.AgentOperation{OperationID: "op", OwnerUserID: 1, RunID: "actual-run", Kind: "command", Status: "running", Revision: 3, LeaseOwner: repo.owner, LeaseExpiresAt: &future}
	if err := db.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	lease, err := repo.AcquireCommandLease(ctx, 1, "op")
	if err != nil {
		t.Fatal(err)
	}
	id := runtime.ContainerIdentity{ID: strings.Repeat("b", 64), Owner: strings.Repeat("a", 64), TaskID: "actual-run", OperationID: "op"}
	bad := id
	bad.TaskID = "workspace-id"
	if err := repo.BindCommandContainer(ctx, lease, 3, bad); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("错误task未拒绝 %v", err)
	}
	if err := repo.BindCommandContainer(ctx, lease, 3, id); err != nil {
		t.Fatal(err)
	}
	if err := repo.BindCommandContainer(ctx, lease, 3, id); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("重复绑定")
	}
	db.Model(&models.AgentOperation{}).Where("operation_id = ?", "op").Updates(map[string]any{"status": "uncertain", "revision": 4, "lease_expires_at": past})
	db.Model(&models.AgentCommandSlot{}).Where("slot = ?", lease.Slot).Update("lease_until", past)
	items, err := repo.ListOccupiedCommandSlots(ctx)
	if err != nil || len(items) != 1 {
		t.Fatalf("%v %v", items, err)
	}
	item := items[0]
	if item.Identity != id {
		t.Fatalf("身份未持久化 %+v", item)
	}
	for _, mutate := range []func(*admission.CommandSlotSnapshot){func(s *admission.CommandSlotSnapshot) { s.Token = "other" }, func(s *admission.CommandSlotSnapshot) { s.OperationRevision++ }, func(s *admission.CommandSlotSnapshot) { s.Identity.ID = strings.Repeat("c", 64) }, func(s *admission.CommandSlotSnapshot) { s.OperationStatus = "running" }} {
		changed := item
		mutate(&changed)
		if err := repo.ReleaseRecoveredCommandSlot(ctx, changed); !errors.Is(err, repository.ErrConflict) {
			t.Fatalf("CAS未拒绝 %v", err)
		}
	}
	if err := repo.ReleaseRecoveredCommandSlot(ctx, item); err != nil {
		t.Fatal(err)
	}
	var slot models.AgentCommandSlot
	db.First(&slot, lease.Slot)
	if slot.Token != "" || slot.ContainerID != "" || slot.OwnerUserID != 0 {
		t.Fatal("释放不完整")
	}
	if err := repo.ReleaseRecoveredCommandSlot(ctx, item); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("重复释放")
	}
}

func TestCommandSlotObservationBindings(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	if err := db.AutoMigrate(&models.AgentOperation{}, &models.AgentCommandSlot{}); err != nil {
		t.Fatal(err)
	}
	rows := []models.AgentCommandSlot{{Slot: 0}, {Slot: 1, OwnerUserID: 1, OperationID: "wrong-owner", Token: "internal-token", LeaseUntil: time.Now().Add(-time.Hour)}, {Slot: 2, OwnerUserID: 1, OperationID: "matching", Token: "second-token", LeaseUntil: time.Now().Add(-time.Hour)}}
	if err := db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	operations := []models.AgentOperation{{OperationID: "wrong-owner", OwnerUserID: 2, Kind: "command", Status: "succeeded", Revision: 9}, {OperationID: "matching", OwnerUserID: 1, Kind: "command", Status: "uncertain", Revision: 4, ParametersHash: "secret-hash", ResultSummary: "secret-summary"}}
	if err := db.Create(&operations).Error; err != nil {
		t.Fatal(err)
	}
	items, err := NewRepo(db).ListOccupiedCommandSlots(context.Background())
	if err != nil || len(items) != 2 {
		t.Fatalf("占用列表: %+v %v", items, err)
	}
	if items[0].OperationStatus != "" || items[0].OperationRevision != 0 {
		t.Fatalf("跨owner绑定: %+v", items[0])
	}
	if items[1].OperationStatus != "uncertain" || items[1].OperationRevision != 4 || items[1].Token != "second-token" {
		t.Fatalf("可信内部快照: %+v", items[1])
	}
}
