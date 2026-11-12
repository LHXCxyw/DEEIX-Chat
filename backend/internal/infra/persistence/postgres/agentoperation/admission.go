package agentoperation

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const commandSlotCount = 2
const commandLeaseDuration = 2 * time.Minute

var _ repository.AgentCommandAdmissionRepository = (*Repo)(nil)
var _ repository.AgentCommandSlotReclaimer = (*Repo)(nil)

// unboundStaleLease 判断槽位是否为可自动回收的残留：
// 租约已过期、从未绑定容器，且对应操作没有仍在有效操作租约内执行的运行。
// 绑定过容器的租约必须由管理端或回收 worker 核对容器状态后释放。
func unboundStaleLease(row models.AgentCommandSlot, blockers map[string]bool, now time.Time) bool {
	if row.OperationID == "" || row.ContainerID != "" {
		return false
	}
	if !row.LeaseUntil.Before(now) {
		return false
	}
	return !blockers[operationKey(row.OwnerUserID, row.OperationID)]
}

func operationKey(ownerUserID uint, operationID string) string {
	return strconv.FormatUint(uint64(ownerUserID), 10) + ":" + operationID
}

// liveOperationBlockers 返回仍在有效操作租约内执行的操作集合：
// 这些操作可能已经创建容器但尚未完成绑定，不能按残留租约回收。
func liveOperationBlockers(tx *gorm.DB, rows []models.AgentCommandSlot, now time.Time) (map[string]bool, error) {
	blockers := make(map[string]bool, len(rows))
	for _, row := range rows {
		if row.OperationID == "" || row.ContainerID != "" || !row.LeaseUntil.Before(now) {
			continue
		}
		var op models.AgentOperation
		err := tx.Where("owner_user_id = ? AND operation_id = ? AND kind = ?", row.OwnerUserID, row.OperationID, string(domain.Command)).First(&op).Error
		if err == gorm.ErrRecordNotFound {
			continue
		}
		if err != nil {
			return nil, dberror.Translate(err)
		}
		if op.Status == string(domain.Running) && op.LeaseExpiresAt != nil && op.LeaseExpiresAt.After(now) {
			blockers[operationKey(row.OwnerUserID, row.OperationID)] = true
		}
	}
	return blockers, nil
}

func releaseSlot(tx *gorm.DB, slot int) error {
	return tx.Model(&models.AgentCommandSlot{}).Where("slot = ?", slot).Updates(map[string]any{
		"owner_user_id": 0, "operation_id": "", "token": "", "lease_until": time.Time{},
		"container_id": "", "container_owner": "", "container_task_id": "", "container_operation_id": "",
	}).Error
}

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
		// 同一操作重入时直接复用租约：网络重试或同一 tool call 的幂等重放不能判成繁忙。
		for _, row := range rows {
			if row.OwnerUserID == ownerUserID && row.OperationID == operationID && row.Token != "" && row.LeaseUntil.After(now) {
				lease = admission.Lease{Slot: row.Slot, OwnerUserID: row.OwnerUserID, OperationID: row.OperationID, Token: row.Token}
				return nil
			}
		}
		// 进程重启或异常提前返回会留下“已过期且从未绑定容器”的槽位；
		// 这类残留没有需要清理的容器，必须先回收，否则命令与浏览器会永久不可用。
		blockers, err := liveOperationBlockers(tx, rows, now)
		if err != nil {
			return err
		}
		for index, row := range rows {
			if !unboundStaleLease(row, blockers, now) {
				continue
			}
			if err := releaseSlot(tx, row.Slot); err != nil {
				return dberror.Translate(err)
			}
			rows[index].OwnerUserID = 0
			rows[index].OperationID = ""
			rows[index].Token = ""
			rows[index].LeaseUntil = time.Time{}
		}
		// 用户级并发限制必须在回收后、对全部槽位统一判断，不能只看当前候选槽位。
		for _, row := range rows {
			if row.OwnerUserID == ownerUserID {
				return admission.ErrBusy
			}
		}
		for _, row := range rows {
			if row.OperationID != "" || row.OwnerUserID != 0 || !row.LeaseUntil.IsZero() {
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

// ReleaseStaleCommandLeases 回收所有“过期且从未绑定容器”的残留租约。
// 只改槽位行，不改操作状态；仍在有效操作租约内执行的操作一律保留。
func (r *Repo) ReleaseStaleCommandLeases(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []models.AgentCommandSlot
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("operation_id <> '' AND container_id = ''").Order("slot").Find(&rows).Error; err != nil {
			return dberror.Translate(err)
		}
		now := time.Now().UTC()
		blockers, err := liveOperationBlockers(tx, rows, now)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if !unboundStaleLease(row, blockers, now) {
				continue
			}
			if err := releaseSlot(tx, row.Slot); err != nil {
				return dberror.Translate(err)
			}
			count++
		}
		return nil
	})
	return count, err
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
