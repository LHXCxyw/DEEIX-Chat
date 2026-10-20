package agentoperation

import (
	"context"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"regexp"
	"time"
)

var _ repository.AgentCommandSlotRecoveryRepository = (*Repo)(nil)
var immutableIdentity = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (r *Repo) ListOccupiedCommandSlots(ctx context.Context) ([]admission.CommandSlotSnapshot, error) {
	items := make([]admission.CommandSlotSnapshot, 0)
	err := r.db.WithContext(ctx).Table("chat_agent_command_slots AS s").
		Select("s.*, o.run_id AS operation_run_id, o.status AS operation_status, o.revision AS operation_revision, o.lease_expires_at AS operation_lease_until, o.lease_owner AS operation_lease_owner").
		Joins("LEFT JOIN chat_agent_operations AS o ON o.operation_id = s.operation_id AND o.owner_user_id = s.owner_user_id AND o.kind = ?", "command").
		Where("s.owner_user_id <> 0 OR s.operation_id <> '' OR s.token <> '' OR s.lease_until <> ?", time.Time{}).Order("s.slot").Scan(&items).Error
	return items, dberror.Translate(err)
}

func slotIdentity(tx *gorm.DB, lease admission.Lease) *gorm.DB {
	return tx.Model(&models.AgentCommandSlot{}).Where("slot = ? AND owner_user_id = ? AND operation_id = ? AND token = ?", lease.Slot, lease.OwnerUserID, lease.OperationID, lease.Token)
}

func (r *Repo) BindCommandContainer(ctx context.Context, lease admission.Lease, revision uint64, id runtime.ContainerIdentity) error {
	if lease.Token == "" || lease.OwnerUserID == 0 || !immutableIdentity.MatchString(id.ID) || !immutableIdentity.MatchString(id.Owner) || id.TaskID == "" || id.OperationID != lease.OperationID {
		return repository.ErrInvalidInput
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var op models.AgentOperation
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("owner_user_id = ? AND operation_id = ? AND kind = ? AND status = ? AND revision = ? AND run_id = ? AND lease_owner = ? AND lease_expires_at > CURRENT_TIMESTAMP", lease.OwnerUserID, lease.OperationID, "command", "running", revision, id.TaskID, r.owner).First(&op).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				return repository.ErrConflict
			}
			return dberror.Translate(err)
		}
		return changed(slotIdentity(tx, lease).Where("container_id = '' AND lease_until > CURRENT_TIMESTAMP").Updates(map[string]any{"container_id": id.ID, "container_owner": id.Owner, "container_task_id": id.TaskID, "container_operation_id": id.OperationID}))
	})
}

func (r *Repo) ReleaseRecoveredCommandSlot(ctx context.Context, snapshot admission.CommandSlotSnapshot) error {
	id := snapshot.Identity
	if snapshot.OperationStatus != "uncertain" || snapshot.Token == "" || snapshot.OwnerUserID == 0 || !immutableIdentity.MatchString(id.ID) || !immutableIdentity.MatchString(id.Owner) || id.TaskID == "" || id.TaskID != snapshot.OperationRunID || id.OperationID != snapshot.OperationID {
		return repository.ErrConflict
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var op models.AgentOperation
		query := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("owner_user_id = ? AND operation_id = ? AND kind = ? AND status = ? AND revision = ? AND run_id = ? AND lease_owner = ? AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)", snapshot.OwnerUserID, snapshot.OperationID, "command", "uncertain", snapshot.OperationRevision, id.TaskID, snapshot.OperationLeaseOwner)
		if snapshot.OperationLeaseUntil == nil {
			query = query.Where("lease_expires_at IS NULL")
		} else {
			query = query.Where("lease_expires_at = ?", *snapshot.OperationLeaseUntil)
		}
		if err := query.First(&op).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				return repository.ErrConflict
			}
			return dberror.Translate(err)
		}
		lease := admission.Lease{Slot: snapshot.Slot, OwnerUserID: snapshot.OwnerUserID, OperationID: snapshot.OperationID, Token: snapshot.Token}
		return changed(slotIdentity(tx, lease).Where("lease_until = ? AND lease_until <= CURRENT_TIMESTAMP AND container_id = ? AND container_owner = ? AND container_task_id = ? AND container_operation_id = ?", snapshot.LeaseUntil, id.ID, id.Owner, id.TaskID, id.OperationID).Updates(map[string]any{"owner_user_id": 0, "operation_id": "", "token": "", "lease_until": time.Time{}, "container_id": "", "container_owner": "", "container_task_id": "", "container_operation_id": ""}))
	})
}
