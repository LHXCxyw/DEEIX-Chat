package conversation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type reclaimRepo struct {
	repository.AgentOperationRepository
	slots    []admission.CommandSlotSnapshot
	stale    int64
	released []admission.CommandSlotSnapshot
}

func (*reclaimRepo) AcquireCommandLease(context.Context, uint, string) (admission.Lease, error) {
	return admission.Lease{}, admission.ErrBusy
}
func (*reclaimRepo) ReleaseCommandLease(context.Context, admission.Lease) error { return nil }
func (r *reclaimRepo) ReleaseStaleCommandLeases(context.Context) (int64, error) { return r.stale, nil }
func (r *reclaimRepo) ListOccupiedCommandSlots(context.Context) ([]admission.CommandSlotSnapshot, error) {
	return r.slots, nil
}
func (r *reclaimRepo) BindCommandContainer(context.Context, admission.Lease, uint64, runtime.ContainerIdentity) error {
	return nil
}
func (r *reclaimRepo) ReleaseRecoveredCommandSlot(_ context.Context, snapshot admission.CommandSlotSnapshot) error {
	r.released = append(r.released, snapshot)
	return nil
}

type reclaimExecutor struct {
	recovered int
	err       error
}

func (*reclaimExecutor) Execute(context.Context, runtime.Request) (runtime.Result, error) {
	return runtime.Result{}, nil
}
func (e *reclaimExecutor) RecoverContainer(context.Context, runtime.ContainerIdentity) error {
	if e.err != nil {
		return e.err
	}
	e.recovered++
	return nil
}

func newReclaimService(repo *reclaimRepo, executor *reclaimExecutor) *Service {
	return &Service{agentRuntime: &agentCommandRuntime{executor: executor, repo: repo, admission: repo, image: "local/runner@sha256:" + containerID64}}
}

const containerID64 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestReclaimStaleAgentSlots(t *testing.T) {
	past := time.Now().UTC().Add(-time.Hour)
	future := time.Now().UTC().Add(time.Hour)
	repo := &reclaimRepo{slots: []admission.CommandSlotSnapshot{
		{Slot: 0, OwnerUserID: 1, OperationID: "bound", Token: "t0", LeaseUntil: past, OperationStatus: "uncertain", OperationLeaseUntil: &past, Identity: runtime.ContainerIdentity{ID: containerID64, Owner: containerID64, TaskID: "run", OperationID: "bound"}},
		{Slot: 1, OwnerUserID: 1, OperationID: "live", Token: "t1", LeaseUntil: past, OperationStatus: "running", OperationLeaseUntil: &future, Identity: runtime.ContainerIdentity{ID: containerID64, Owner: containerID64, TaskID: "run", OperationID: "live"}},
		{Slot: 2, OwnerUserID: 1, OperationID: "unbound", Token: "t2", LeaseUntil: past, OperationStatus: "uncertain", OperationLeaseUntil: &past},
	}, stale: 1}
	executor := &reclaimExecutor{}
	released, recovered := newReclaimService(repo, executor).ReclaimStaleAgentSlots(context.Background())
	if released != 1 || recovered != 1 {
		t.Fatalf("released=%d recovered=%d", released, recovered)
	}
	if executor.recovered != 1 || len(repo.released) != 1 || repo.released[0].OperationID != "bound" {
		t.Fatalf("只应回收已确认清理的绑定容器: %+v", repo.released)
	}
}

func TestReclaimKeepsSlotWhenCleanupUnconfirmed(t *testing.T) {
	past := time.Now().UTC().Add(-time.Hour)
	repo := &reclaimRepo{slots: []admission.CommandSlotSnapshot{
		{Slot: 0, OwnerUserID: 1, OperationID: "bound", Token: "t0", LeaseUntil: past, OperationStatus: "uncertain", OperationLeaseUntil: &past, Identity: runtime.ContainerIdentity{ID: containerID64, Owner: containerID64, TaskID: "run", OperationID: "bound"}},
	}}
	executor := &reclaimExecutor{err: errors.New("删除失败")}
	released, recovered := newReclaimService(repo, executor).ReclaimStaleAgentSlots(context.Background())
	if released != 0 || recovered != 0 || len(repo.released) != 0 {
		t.Fatalf("清理未确认时不得释放: released=%d recovered=%d %+v", released, recovered, repo.released)
	}
}
