package agentoperation

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const commandSlotCount = 2
const commandLeaseDuration = 2 * time.Minute

var _ repository.AgentCommandAdmissionRepository = (*Repo)(nil)

func (r *Repo) AcquireCommandLease(ctx context.Context, ownerUserID uint, operationID string) (admission.Lease, error) {
	if ownerUserID == 0 || operationID == "" {
		return admission.Lease{}, repository.ErrInvalidInput
	}
	var lease admission.Lease
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Rows are fixed and created transactionally; the unique slot key makes this safe across instances.
		for slot := 0; slot < commandSlotCount; slot++ {
			row := models.AgentCommandSlot{Slot: slot}
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
				return dberror.Translate(err)
			}
		}
		var rows []models.AgentCommandSlot
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Order("slot").Find(&rows).Error; err != nil {
			return dberror.Translate(err)
		}
		now := time.Now().UTC()
		for _, row := range rows {
			// 用户级并发限制必须在所有槽位锁定后判断，不能只看当前候选槽位。
			if row.OwnerUserID == ownerUserID {
				return admission.ErrBusy
			}
			if row.OperationID != "" {
				continue
			}
			// 非空租约永不因时间经过而自动回收；只有显式确认清理后才可复用。
			if row.OwnerUserID != 0 || !row.LeaseUntil.IsZero() {
				continue
			}
			tokenBytes := make([]byte, 24)
			if _, err := rand.Read(tokenBytes); err != nil {
				return err
			}
			token := hex.EncodeToString(tokenBytes)
			updates := map[string]any{"owner_user_id": ownerUserID, "operation_id": operationID, "token": token, "lease_until": now.Add(commandLeaseDuration)}
			if result := tx.Model(&models.AgentCommandSlot{}).Where("slot = ? AND operation_id = '' AND owner_user_id = 0", row.Slot).Updates(updates); result.Error != nil {
				return dberror.Translate(result.Error)
			} else if result.RowsAffected != 1 {
				return repository.ErrConflict
			}
			lease = admission.Lease{Slot: row.Slot, OwnerUserID: ownerUserID, OperationID: operationID, Token: token}
			return nil
		}
		return admission.ErrBusy
	})
	return lease, err
}

func (r *Repo) ReleaseCommandLease(ctx context.Context, lease admission.Lease) error {
	if lease.Token == "" || lease.OperationID == "" || lease.OwnerUserID == 0 {
		return repository.ErrInvalidInput
	}
	result := r.db.WithContext(ctx).Model(&models.AgentCommandSlot{}).Where("slot = ? AND owner_user_id = ? AND operation_id = ? AND token = ?", lease.Slot, lease.OwnerUserID, lease.OperationID, lease.Token).Updates(map[string]any{"owner_user_id": 0, "operation_id": "", "token": "", "lease_until": time.Time{}, "container_id": "", "container_owner": "", "container_task_id": "", "container_operation_id": ""})
	if result.Error != nil {
		return dberror.Translate(result.Error)
	}
	if result.RowsAffected != 1 {
		return repository.ErrConflict
	}
	return nil
}
