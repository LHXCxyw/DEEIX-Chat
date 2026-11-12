package agentoperation

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func openCommandSlotDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&models.AgentOperation{}, &models.AgentCommandSlot{}); err != nil {
		t.Fatal(err)
	}
	return db
}

// TestReleaseStaleCommandLeases 覆盖残留回收边界：
// 只有“租约过期且从未绑定容器、也没有仍在有效租约内运行的操作”的槽位可以被自动回收。
func TestReleaseStaleCommandLeases(t *testing.T) {
	db := openCommandSlotDB(t)
	repo := NewRepo(db)
	ctx := context.Background()
	past := time.Now().UTC().Add(-time.Hour)
	future := time.Now().UTC().Add(time.Hour)
	rows := []models.AgentCommandSlot{
		{Slot: 0, OwnerUserID: 1, OperationID: "orphan", Token: "t0", LeaseUntil: past},
		{Slot: 1, OwnerUserID: 2, OperationID: "live", Token: "t1", LeaseUntil: past},
		{Slot: 2, OwnerUserID: 3, OperationID: "bound", Token: "t2", LeaseUntil: past, ContainerID: strings.Repeat("a", 64), ContainerOwner: strings.Repeat("b", 64), ContainerTaskID: "run", ContainerOperationID: "bound"},
		{Slot: 3, OwnerUserID: 4, OperationID: "active-lease", Token: "t3", LeaseUntil: future},
	}
	if err := db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	operations := []models.AgentOperation{
		{OperationID: "live", OwnerUserID: 2, RunID: "run", Kind: "command", Status: "running", Revision: 2, LeaseOwner: "node", LeaseExpiresAt: &future},
		{OperationID: "bound", OwnerUserID: 3, RunID: "run", Kind: "command", Status: "uncertain", Revision: 4},
		{OperationID: "active-lease", OwnerUserID: 4, RunID: "run", Kind: "command", Status: "running", Revision: 2, LeaseOwner: "node", LeaseExpiresAt: &future},
	}
	if err := db.Create(&operations).Error; err != nil {
		t.Fatal(err)
	}
	count, err := repo.ReleaseStaleCommandLeases(ctx)
	if err != nil || count != 1 {
		t.Fatalf("只应回收一个未绑定残留: count=%d err=%v", count, err)
	}
	var released models.AgentCommandSlot
	if err := db.Where("slot = ?", 0).First(&released).Error; err != nil {
		t.Fatal(err)
	}
	if released.OwnerUserID != 0 || released.OperationID != "" || released.Token != "" {
		t.Fatalf("残留未释放: %+v", released)
	}
	for _, slot := range []int{1, 2, 3} {
		var kept models.AgentCommandSlot
		if err := db.Where("slot = ?", slot).First(&kept).Error; err != nil {
			t.Fatal(err)
		}
		if kept.OwnerUserID == 0 || kept.OperationID == "" {
			t.Fatalf("槽位 %d 被错误释放: %+v", slot, kept)
		}
	}
}

// TestAcquireReclaimsOnlyUnboundStaleLease 校验准入路径本身就能恢复可用性，
// 同时不抢占仍在执行的操作与已绑定容器的租约。
func TestAcquireReclaimsOnlyUnboundStaleLease(t *testing.T) {
	db := openCommandSlotDB(t)
	repo := NewRepo(db)
	ctx := context.Background()
	past := time.Now().UTC().Add(-time.Hour)
	future := time.Now().UTC().Add(time.Hour)
	rows := []models.AgentCommandSlot{
		{Slot: 0, OwnerUserID: 1, OperationID: "orphan", Token: "t0", LeaseUntil: past},
		{Slot: 1, OwnerUserID: 2, OperationID: "live", Token: "t1", LeaseUntil: past},
	}
	if err := db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&models.AgentOperation{OperationID: "live", OwnerUserID: 2, RunID: "run", Kind: "command", Status: "running", Revision: 2, LeaseOwner: "node", LeaseExpiresAt: &future}).Error; err != nil {
		t.Fatal(err)
	}
	lease, err := repo.AcquireCommandLease(ctx, 3, "new-op")
	if err != nil {
		t.Fatalf("未绑定残留未在准入时回收: %v", err)
	}
	if lease.Slot != 0 {
		t.Fatalf("应复用已回收槽位: %+v", lease)
	}
	if _, err := repo.AcquireCommandLease(ctx, 4, "other-op"); err == nil {
		t.Fatal("仍被有效运行占用的槽位不应被回收")
	}
}
