package admin

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"time"
)

var ErrCommandSlotBlocked = errors.New("命令槽位恢复被阻止")

type CommandSlotView struct {
	Slot                int        `json:"slot"`
	OwnerUserID         uint       `json:"owner_user_id"`
	OperationID         string     `json:"operation_id"`
	OperationStatus     string     `json:"operation_status"`
	OperationRevision   uint64     `json:"operation_revision"`
	LeaseUntil          time.Time  `json:"lease_until"`
	OperationLeaseUntil *time.Time `json:"operation_lease_until,omitempty"`
	Snapshot            string     `json:"snapshot"`
	Recovery            string     `json:"recovery"`
	BlockedReason       string     `json:"blocked_reason"`
}
type RecoverCommandSlotInput struct {
	Slot              int    `json:"-"`
	OwnerUserID       uint   `json:"owner_user_id"`
	OperationID       string `json:"operation_id"`
	OperationRevision uint64 `json:"operation_revision"`
	Snapshot          string `json:"snapshot"`
}
type CommandSlotService struct {
	store   repository.AgentCommandSlotObserver
	key     []byte
	runtime runtime.Recoverer
}

func NewCommandSlotService(store repository.AgentCommandSlotObserver, signingKey string, recoverer ...runtime.Recoverer) *CommandSlotService {
	s := &CommandSlotService{store: store, key: []byte(signingKey)}
	if len(recoverer) > 0 {
		s.runtime = recoverer[0]
	}
	return s
}
func (s *CommandSlotService) snapshot(item admission.CommandSlotSnapshot) string {
	raw, _ := json.Marshal([]any{"agent-command-slot-snapshot-v2", item.Slot, item.OwnerUserID, item.OperationID, item.Token, item.LeaseUntil, item.OperationStatus, item.OperationRevision, item.OperationLeaseUntil, item.OperationLeaseOwner, item.OperationRunID, item.Identity})
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}
func (s *CommandSlotService) view(item admission.CommandSlotSnapshot) CommandSlotView {
	reason := "trusted_container_identity_missing"
	now := time.Now().UTC()
	if item.OperationStatus == "" {
		reason = "operation_binding_missing"
	} else if item.OperationStatus == "running" || item.LeaseUntil.After(now) || (item.OperationLeaseUntil != nil && item.OperationLeaseUntil.After(now)) {
		reason = "active_lease_or_running_operation"
	} else if item.OperationStatus != "uncertain" {
		reason = "operation_not_uncertain"
	} else if item.Token != "" && item.Identity.ID != "" && item.Identity.Owner != "" && item.Identity.TaskID != "" && item.Identity.TaskID == item.OperationRunID && item.Identity.OperationID == item.OperationID {
		reason = ""
		if s.runtime == nil {
			reason = "recovery_runtime_unavailable"
		}
		if _, ok := s.store.(repository.AgentCommandSlotRecoveryRepository); !ok {
			reason = "recovery_repository_unavailable"
		}
	}
	recovery := "blocked"
	if reason == "" {
		recovery = "available"
	}
	return CommandSlotView{Slot: item.Slot, OwnerUserID: item.OwnerUserID, OperationID: item.OperationID, OperationStatus: item.OperationStatus, OperationRevision: item.OperationRevision, LeaseUntil: item.LeaseUntil, OperationLeaseUntil: item.OperationLeaseUntil, Snapshot: s.snapshot(item), Recovery: recovery, BlockedReason: reason}
}
func (s *CommandSlotService) List(ctx context.Context) ([]CommandSlotView, error) {
	if s == nil || s.store == nil || len(s.key) == 0 {
		return nil, ErrCommandSlotBlocked
	}
	items, err := s.store.ListOccupiedCommandSlots(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]CommandSlotView, 0, len(items))
	for _, item := range items {
		views = append(views, s.view(item))
	}
	return views, nil
}
func (s *CommandSlotService) Recover(ctx context.Context, input RecoverCommandSlotInput) (*CommandSlotView, error) {
	if input.Slot < 0 || input.OwnerUserID == 0 || input.OperationID == "" || len(input.Snapshot) != 64 {
		return nil, repository.ErrInvalidInput
	}
	if s == nil || s.store == nil || len(s.key) == 0 {
		return nil, ErrCommandSlotBlocked
	}
	items, err := s.store.ListOccupiedCommandSlots(ctx)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Slot != input.Slot {
			continue
		}
		view := s.view(item)
		if item.OwnerUserID != input.OwnerUserID || item.OperationID != input.OperationID || item.OperationRevision != input.OperationRevision || !hmac.Equal([]byte(view.Snapshot), []byte(input.Snapshot)) {
			return nil, repository.ErrConflict
		}
		if view.Recovery != "available" {
			return &view, ErrCommandSlotBlocked
		}
		if err := s.runtime.RecoverContainer(ctx, item.Identity); err != nil {
			view.Recovery = "blocked"
			view.BlockedReason = "container_cleanup_unconfirmed"
			return &view, errors.Join(ErrCommandSlotBlocked, err)
		}
		if err := s.store.(repository.AgentCommandSlotRecoveryRepository).ReleaseRecoveredCommandSlot(ctx, item); err != nil {
			return nil, err
		}
		view.Recovery = "released"
		return &view, nil
	}
	return nil, repository.ErrConflict
}
