package agentoperation

import (
	"context"
	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/gorm"
)

var _ repository.AgentOperationReconciliationRepository = (*Repo)(nil)

func (r *Repo) expired(ctx context.Context) *gorm.DB {
	return r.db.WithContext(ctx).Where("status = ? AND kind = ? AND lease_owner <> '' AND lease_expires_at < CURRENT_TIMESTAMP", domain.Running, domain.Command)
}

// ListExpiredRunning 只返回指定用户的明确过期命令，不按创建时间推断中断。
func (r *Repo) ListExpiredRunning(ctx context.Context, owner uint, limit int) ([]domain.Operation, error) {
	if owner == 0 || limit <= 0 || limit > 100 {
		return nil, repository.ErrInvalidInput
	}
	var records []models.AgentOperation
	if err := r.expired(ctx).Where("owner_user_id = ?", owner).Order("id").Limit(limit).Find(&records).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	items := make([]domain.Operation, 0, len(records))
	for _, record := range records {
		items = append(items, toDomain(record))
	}
	return items, nil
}

// MarkExpiredUncertain 对查询快照与数据库时钟再次做 CAS；不提供接管或重放授权。
func (r *Repo) MarkExpiredUncertain(ctx context.Context, item domain.Operation) error {
	if item.OwnerUserID == 0 || item.OperationID == "" || item.Status != domain.Running || item.Kind != domain.Command || item.LeaseOwner == "" || item.LeaseExpiresAt == nil {
		return repository.ErrInvalidInput
	}
	return changed(r.expired(ctx).Model(&models.AgentOperation{}).Where("owner_user_id = ? AND operation_id = ? AND revision = ? AND lease_owner = ? AND lease_expires_at = ?", item.OwnerUserID, item.OperationID, item.Revision, item.LeaseOwner, item.LeaseExpiresAt).Updates(map[string]any{
		"status": string(domain.Uncertain), "revision": gorm.Expr("revision + 1"), "result_summary": `{"event":"command_lease_expired","execution_result":"unknown","container_cleanup":"unverified","automatic_replay":false}`,
	}))
}

// ReconcileExpired 是系统内部可信入口；无租约旧记录不作推断，不向 HTTP 暴露。
func (r *Repo) ReconcileExpired(ctx context.Context) (int64, error) {
	var candidates []models.AgentOperation
	if err := r.expired(ctx).Order("id").Limit(100).Find(&candidates).Error; err != nil {
		return 0, dberror.Translate(err)
	}
	var count int64
	for _, item := range candidates {
		err := r.MarkExpiredUncertain(ctx, toDomain(item))
		if err == repository.ErrConflict {
			continue
		}
		if err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
