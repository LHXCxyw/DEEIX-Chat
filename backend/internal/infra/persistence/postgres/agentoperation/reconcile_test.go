package agentoperation

import (
	"context"
	"errors"
	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"sync"
	"testing"
	"time"
)

func TestExpiredLeaseCAS(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	if err := db.AutoMigrate(&models.AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	first, other := NewRepo(db), NewRepo(db)
	hash, _ := domain.ParametersHash([]byte(`{}`))
	create := func(id string) *domain.Operation {
		t.Helper()
		spec := domain.Spec{OwnerUserID: 1, OperationID: id, RunID: "run", WorkspaceID: 1, Kind: domain.Command, ParametersHash: hash, ExpectedWorkspaceVersion: "v1", PermissionScope: "command"}
		if _, err := first.Create(ctx, spec); err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		if err := first.Approve(ctx, 1, id, 1, domain.Approval{Binding: spec.Binding(), GrantedAt: now, ExpiresAt: now.Add(time.Minute)}); err != nil {
			t.Fatal(err)
		}
		if err := first.Transition(ctx, 1, id, 2, domain.Pending, domain.Running, spec.Binding(), ""); err != nil {
			t.Fatal(err)
		}
		item, err := first.Get(ctx, 1, id)
		if err != nil || item.LeaseOwner == "" || item.LeaseExpiresAt == nil {
			t.Fatalf("租约未持久化: %+v %v", item, err)
		}
		return item
	}
	live := create("live")
	if err := other.Transition(ctx, 1, "live", 3, domain.Running, domain.Succeeded, live.Binding(), ""); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("其他实例完成活跃命令: %v", err)
	}
	create("expired")
	create("legacy")
	past := time.Now().UTC().Add(-time.Minute)
	db.Model(&models.AgentOperation{}).Where("operation_id = ?", "expired").Update("lease_expires_at", past)
	db.Model(&models.AgentOperation{}).Where("operation_id = ?", "legacy").Updates(map[string]any{"lease_owner": "", "lease_expires_at": nil})
	// 创建时间再老也不能覆盖新鲜租约。
	db.Model(&models.AgentOperation{}).Where("operation_id = ?", "live").Update("created_at", past.Add(-24*time.Hour))
	if items, err := first.ListExpiredRunning(ctx, 2, 100); err != nil || len(items) != 0 {
		t.Fatalf("owner泄漏: %+v %v", items, err)
	}
	items, err := first.ListExpiredRunning(ctx, 1, 100)
	if err != nil || len(items) != 1 || items[0].OperationID != "expired" {
		t.Fatalf("过期查询: %+v %v", items, err)
	}
	wrong := items[0]
	wrong.OwnerUserID = 2
	if err := first.MarkExpiredUncertain(ctx, wrong); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("CAS owner泄漏: %v", err)
	}
	stale := items[0]
	stale.Revision++
	if err := first.MarkExpiredUncertain(ctx, stale); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("过期revision未拒绝: %v", err)
	}
	if err := first.MarkExpiredUncertain(ctx, *live); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("新鲜租约被核对: %v", err)
	}
	var wg sync.WaitGroup
	counts := make(chan int64, 2)
	errs := make(chan error, 2)
	for _, repo := range []*Repo{first, other} {
		wg.Add(1)
		go func(r *Repo) { defer wg.Done(); n, e := r.ReconcileExpired(ctx); counts <- n; errs <- e }(repo)
	}
	wg.Wait()
	close(counts)
	close(errs)
	var total int64
	for n := range counts {
		total += n
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if total != 1 {
		t.Fatalf("过期CAS重复: %d", total)
	}
	for _, id := range []string{"live", "legacy"} {
		item, _ := first.Get(ctx, 1, id)
		if item.Status != domain.Running || item.Revision != 3 {
			t.Fatalf("误判 %s: %+v", id, item)
		}
	}
	expired, _ := first.Get(ctx, 1, "expired")
	if expired.Status != domain.Uncertain || expired.Revision != 4 {
		t.Fatalf("未核对过期: %+v", expired)
	}
	if err := first.Transition(ctx, 1, "expired", 3, domain.Running, domain.Succeeded, expired.Binding(), ""); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("旧完成覆盖核对: %v", err)
	}
	if err := first.Transition(ctx, 1, "expired", 4, domain.Uncertain, domain.Running, expired.Binding(), ""); !errors.Is(err, domain.ErrTransition) {
		t.Fatalf("重放命令: %v", err)
	}
}
