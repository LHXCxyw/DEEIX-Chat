package admin

import (
	"context"
	"encoding/json"
	"errors"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type slotObserver struct {
	items []admission.CommandSlotSnapshot
	err   error
}

func (o *slotObserver) ListOccupiedCommandSlots(context.Context) ([]admission.CommandSlotSnapshot, error) {
	return o.items, o.err
}

type recoveryStore struct {
	slotObserver
	releases int
}

func (s *recoveryStore) BindCommandContainer(context.Context, admission.Lease, uint64, runtime.ContainerIdentity) error {
	return nil
}
func (s *recoveryStore) ReleaseRecoveredCommandSlot(_ context.Context, snapshot admission.CommandSlotSnapshot) error {
	s.releases++
	if !reflect.DeepEqual(snapshot, s.items[0]) {
		return repository.ErrConflict
	}
	s.items = nil
	return nil
}

type recoveryRuntime struct {
	calls     int
	err       error
	onRecover func()
}

func (r *recoveryRuntime) RecoverContainer(context.Context, runtime.ContainerIdentity) error {
	r.calls++
	if r.onRecover != nil {
		r.onRecover()
	}
	return r.err
}
func TestCommandSlotRealRecovery(t *testing.T) {
	past := time.Now().Add(-time.Hour)
	original := admission.CommandSlotSnapshot{Slot: 0, OwnerUserID: 1, OperationID: "op", Token: "secret", LeaseUntil: past, OperationStatus: "uncertain", OperationRevision: 4, OperationLeaseUntil: &past, OperationLeaseOwner: "lease-owner", OperationRunID: "run", Identity: runtime.ContainerIdentity{ID: strings.Repeat("b", 64), Owner: strings.Repeat("a", 64), TaskID: "run", OperationID: "op"}}
	for _, scenario := range []string{"success", "cleanup_failure", "cas_conflict", "running", "fresh", "unbound", "snapshot_identity_changed"} {
		t.Run(scenario, func(t *testing.T) {
			store := &recoveryStore{slotObserver: slotObserver{items: []admission.CommandSlotSnapshot{original}}}
			runner := &recoveryRuntime{}
			if scenario == "running" {
				store.items[0].OperationStatus = "running"
			}
			if scenario == "fresh" {
				store.items[0].LeaseUntil = time.Now().Add(time.Hour)
			}
			if scenario == "unbound" {
				store.items[0].Identity = runtime.ContainerIdentity{}
			}
			if scenario == "cleanup_failure" {
				runner.err = runtime.ErrCleanup
			}
			if scenario == "cas_conflict" {
				runner.onRecover = func() { store.items[0].Token = "new-token" }
			}
			service := NewCommandSlotService(store, "signing-key", runner)
			views, err := service.List(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			input := RecoverCommandSlotInput{Slot: 0, OwnerUserID: 1, OperationID: "op", OperationRevision: 4, Snapshot: views[0].Snapshot}
			if scenario == "snapshot_identity_changed" {
				store.items[0].Identity.ID = strings.Repeat("c", 64)
			}
			view, err := service.Recover(context.Background(), input)
			if scenario == "success" {
				if err != nil || view.Recovery != "released" || store.releases != 1 || runner.calls != 1 {
					t.Fatalf("未真实释放 %+v %v", view, err)
				}
				return
			}
			if err == nil {
				t.Fatal("错误路径未拒绝")
			}
			if scenario == "cas_conflict" {
				if !errors.Is(err, repository.ErrConflict) {
					t.Fatal(err)
				}
			} else if store.releases != 0 {
				t.Fatal("不安全释放")
			}
			if (scenario == "running" || scenario == "fresh" || scenario == "unbound" || scenario == "snapshot_identity_changed") && runner.calls != 0 {
				t.Fatal("阻断路径触发Docker")
			}
		})
	}
}

func TestCommandSlotConservativeRecovery(t *testing.T) {
	past := time.Now().Add(-time.Hour)
	observer := &slotObserver{items: []admission.CommandSlotSnapshot{{Slot: 0, OwnerUserID: 1, OperationID: "command-test", Token: "secret-lease-token", LeaseUntil: past, OperationStatus: "uncertain", OperationRevision: 4, OperationLeaseUntil: &past, OperationLeaseOwner: "secret-owner"}}}
	service := NewCommandSlotService(observer, "server-signing-secret")
	ctx := context.Background()
	views, err := service.List(ctx)
	if err != nil || len(views) != 1 {
		t.Fatalf("列表失败: %v %v", views, err)
	}
	raw, _ := json.Marshal(views)
	for _, secret := range []string{"secret-lease-token", "secret-owner", "server-signing-secret", "parameters", "result_summary"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("泄漏敏感字段: %s", secret)
		}
	}
	input := RecoverCommandSlotInput{Slot: 0, OwnerUserID: 1, OperationID: "command-test", OperationRevision: 4, Snapshot: views[0].Snapshot}
	view, err := service.Recover(ctx, input)
	if !errors.Is(err, ErrCommandSlotBlocked) || view.BlockedReason != "trusted_container_identity_missing" {
		t.Fatalf("无绑定必须阻断: %+v %v", view, err)
	}
	// 每项快照身份变更都必须被识别，不能作用到新租约。
	for _, mutate := range []func(*admission.CommandSlotSnapshot){
		func(s *admission.CommandSlotSnapshot) { s.Token = "rotated" },
		func(s *admission.CommandSlotSnapshot) { s.OperationRevision++ },
		func(s *admission.CommandSlotSnapshot) { s.OwnerUserID++ },
		func(s *admission.CommandSlotSnapshot) { s.OperationID = "other" },
		func(s *admission.CommandSlotSnapshot) { s.OperationLeaseOwner = "other" },
	} {
		original := observer.items[0]
		mutate(&observer.items[0])
		if _, err := service.Recover(ctx, input); !errors.Is(err, repository.ErrConflict) {
			t.Fatalf("快照变更未拒绝: %v", err)
		}
		observer.items[0] = original
	}
	observer.items[0].OperationStatus = "running"
	views, _ = service.List(ctx)
	input.Snapshot = views[0].Snapshot
	view, err = service.Recover(ctx, input)
	if !errors.Is(err, ErrCommandSlotBlocked) || view.BlockedReason != "active_lease_or_running_operation" {
		t.Fatalf("running必须拒绝: %+v %v", view, err)
	}
	observer.items[0].OperationStatus = "uncertain"
	observer.items[0].LeaseUntil = time.Now().Add(time.Hour)
	views, _ = service.List(ctx)
	input.Snapshot = views[0].Snapshot
	view, err = service.Recover(ctx, input)
	if !errors.Is(err, ErrCommandSlotBlocked) || view.BlockedReason != "active_lease_or_running_operation" {
		t.Fatalf("fresh必须拒绝: %+v %v", view, err)
	}
	observer.items = nil
	if _, err := service.Recover(ctx, input); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("不存在不得假成功: %v", err)
	}
	observer.err = errors.New("database unavailable")
	if _, err := service.List(ctx); err != observer.err {
		t.Fatal("数据库错误被掩盖")
	}
	input.Snapshot = ""
	if _, err := service.Recover(ctx, input); !errors.Is(err, repository.ErrInvalidInput) {
		t.Fatal("缺失快照应拒绝")
	}
}
