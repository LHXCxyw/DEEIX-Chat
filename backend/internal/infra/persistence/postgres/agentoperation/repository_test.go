package agentoperation

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/schema"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestRepositorySQLite(t *testing.T) {
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
	testRepository(t, db)
}

func TestRepositoryPostgres(t *testing.T) {
	dsn := os.Getenv("DEEIX_TEST_DATABASE_DSN")
	if dsn == "" {
		t.Skip("未设置 DEEIX_TEST_DATABASE_DSN，跳过PostgreSQL集成测试")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	name := fmt.Sprintf("agent_operation_test_%d", time.Now().UnixNano())
	if err := db.Exec("CREATE SCHEMA " + name).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = db.Exec("SET search_path TO public").Error
		_ = db.Exec("DROP SCHEMA " + name + " CASCADE").Error
	})
	if err := db.Exec("SET search_path TO " + name).Error; err != nil {
		t.Fatal(err)
	}
	testRepository(t, db)
}

func testRepository(t *testing.T, db *gorm.DB) {
	t.Helper()
	registered := false
	for _, model := range schema.Models() {
		if _, ok := model.(*models.AgentOperation); ok {
			registered = true
		}
	}
	if !registered {
		t.Fatal("模型未注册")
	}
	if err := db.AutoMigrate(&models.AgentOperation{}, &models.AgentCommandSlot{}); err != nil {
		t.Fatal(err)
	}
	repo := NewRepo(db)
	ctx := context.Background()
	past := time.Now().UTC().Add(-time.Hour)
	if err := db.Create(&models.AgentCommandSlot{Slot: 0, OwnerUserID: 9, OperationID: "stale-0", Token: "stale-token-0", LeaseUntil: past}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&models.AgentCommandSlot{Slot: 1, OwnerUserID: 9, OperationID: "stale-1", Token: "stale-token-1", LeaseUntil: past}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AcquireCommandLease(ctx, 9, "same-user"); !errors.Is(err, admission.ErrBusy) {
		t.Fatal("同一用户不能跨槽并发或复用过期租约", err)
	}
	if _, err := repo.AcquireCommandLease(ctx, 10, "expired-reuse"); !errors.Is(err, admission.ErrBusy) {
		t.Fatal("过期租约未经确认清理不得复用", err)
	}
	if err := db.Where("slot IN ?", []int{0, 1}).Delete(&models.AgentCommandSlot{}).Error; err != nil {
		t.Fatal(err)
	}
	hash, _ := domain.ParametersHash([]byte(`{"path":"a"}`))
	spec := domain.Spec{OwnerUserID: 1, OperationID: "op", RunID: "run", WorkspaceID: 2, Kind: domain.Command, ParametersHash: hash, ExpectedWorkspaceVersion: "v1", PermissionScope: "workspace:command"}
	item, err := repo.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := repo.Create(ctx, spec)
	if err != nil || duplicate.Revision != 1 {
		t.Fatal("创建未幂等", err)
	}
	other := spec
	other.ParametersHash, _ = domain.ParametersHash([]byte(`{"path":"b"}`))
	if _, err := repo.Create(ctx, other); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("不同参数未冲突", err)
	}
	other = spec
	other.OwnerUserID = 2
	if _, err := repo.Create(ctx, other); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("操作ID不唯一", err)
	}
	if _, err := repo.Get(ctx, 2, "op"); !errors.Is(err, repository.ErrNotFound) {
		t.Fatal("owner未隔离", err)
	}
	if err := repo.Transition(ctx, 1, "op", 1, domain.Pending, domain.Running, spec.Binding(), ""); !errors.Is(err, domain.ErrApproval) {
		t.Fatal("无审批执行", err)
	}
	now := time.Now().UTC()
	approval := domain.Approval{Binding: spec.Binding(), GrantedAt: now, ExpiresAt: now.Add(time.Hour)}
	bad := approval
	bad.PermissionScope = "other"
	if err := repo.Approve(ctx, 1, "op", 1, bad); !errors.Is(err, domain.ErrApproval) {
		t.Fatal("审批绑定失效", err)
	}
	if err := repo.Approve(ctx, 1, "op", 1, approval); err != nil {
		t.Fatal(err)
	}
	if err := repo.Approve(ctx, 1, "op", 1, approval); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("审批CAS失效", err)
	}
	if err := repo.Transition(ctx, 1, "op", 1, domain.Pending, domain.Running, spec.Binding(), ""); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("过时revision未拒绝", err)
	}
	binding := spec.Binding()
	binding.WorkspaceVersion = "v2"
	if err := repo.Transition(ctx, 1, "op", 2, domain.Pending, domain.Running, binding, ""); !errors.Is(err, domain.ErrApproval) {
		t.Fatal("执行绑定失效", err)
	}
	if err := repo.Transition(ctx, 1, "op", 2, domain.Pending, domain.Running, spec.Binding(), ""); err != nil {
		t.Fatal(err)
	}
	if err := repo.Transition(ctx, 1, "op", 3, domain.Running, domain.Pending, domain.Binding{}, ""); !errors.Is(err, domain.ErrTransition) {
		t.Fatal("中断回pending", err)
	}
	if err := repo.Transition(ctx, 1, "op", 3, domain.Running, domain.Uncertain, domain.Binding{}, "中断，结果未知"); err != nil {
		t.Fatal(err)
	}
	if err := repo.Transition(ctx, 1, "op", 4, domain.Uncertain, domain.Running, spec.Binding(), ""); !errors.Is(err, domain.ErrTransition) {
		t.Fatal("不确定命令重试", err)
	}
	item, err = NewRepo(db).Get(ctx, 1, "op")
	if err != nil || item.Status != domain.Uncertain || item.ResultSummary != "中断，结果未知" || item.Approval == nil {
		t.Fatal("恢复快照错误", err)
	}
	duplicate, err = repo.Create(ctx, spec)
	if err != nil || duplicate.Status != domain.Uncertain {
		t.Fatal("幂等创建重置状态", err)
	}

	spec.OperationID = "read"
	spec.Kind = domain.ReadFile
	if _, err := repo.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	approval.Binding = spec.Binding()
	if err := repo.Approve(ctx, 1, "read", 1, approval); err != nil {
		t.Fatal(err)
	}
	if err := repo.Transition(ctx, 1, "read", 2, domain.Pending, domain.Running, spec.Binding(), ""); err != nil {
		t.Fatal(err)
	}
	if err := repo.Transition(ctx, 1, "read", 3, domain.Running, domain.Uncertain, domain.Binding{}, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&models.AgentOperation{}).Where("operation_id = ?", "read").Update("approval_expires_at", now.Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.Transition(ctx, 1, "read", 4, domain.Uncertain, domain.Running, spec.Binding(), ""); !errors.Is(err, domain.ErrApproval) {
		t.Fatal("过期恢复审批未拒绝", err)
	}
	if err := repo.Approve(ctx, 1, "read", 4, approval); err != nil {
		t.Fatal(err)
	}
	if err := repo.Transition(ctx, 1, "read", 5, domain.Uncertain, domain.Running, spec.Binding(), ""); err != nil {
		t.Fatal(err)
	}
	if err := repo.Transition(ctx, 1, "read", 3, domain.Running, domain.Succeeded, domain.Binding{}, "旧结果"); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("ABA未防止", err)
	}
	if err := repo.Transition(ctx, 1, "read", 6, domain.Running, domain.Succeeded, domain.Binding{}, "已读取"); err != nil {
		t.Fatal(err)
	}
}
