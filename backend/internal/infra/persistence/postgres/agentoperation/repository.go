package agentoperation

import (
	"context"
	"time"

	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repo struct {
	db *gorm.DB
	owner string
}

var _ repository.AgentOperationRepository = (*Repo)(nil)

func NewRepo(db *gorm.DB) *Repo { return &Repo{db: db, owner: uuid.NewString()} }

func (r *Repo) Create(ctx context.Context, spec domain.Spec) (*domain.Operation, error) {
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	record := models.AgentOperation{OperationID: spec.OperationID, OwnerUserID: spec.OwnerUserID, RunID: spec.RunID, WorkspaceID: spec.WorkspaceID, Kind: string(spec.Kind), ParametersHash: spec.ParametersHash, ExpectedWorkspaceVersion: spec.ExpectedWorkspaceVersion, PermissionScope: spec.PermissionScope, Status: string(domain.Pending), Revision: 1}
	result := r.db.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "operation_id"}}, DoNothing: true}).Create(&record)
	if result.Error != nil {
		return nil, dberror.Translate(result.Error)
	}
	if result.RowsAffected == 1 {
		item := toDomain(record)
		return &item, nil
	}
	var existing models.AgentOperation
	// 全局唯一键冲突也按owner查询，不返回其他用户的记录。
	if err := r.db.WithContext(ctx).Where("operation_id = ? AND owner_user_id = ?", spec.OperationID, spec.OwnerUserID).First(&existing).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, repository.ErrConflict
		}
		return nil, dberror.Translate(err)
	}
	item := toDomain(existing)
	if item.Spec != spec {
		return nil, repository.ErrConflict
	}
	return &item, nil
}

func (r *Repo) Get(ctx context.Context, owner uint, id string) (*domain.Operation, error) {
	if owner == 0 || id == "" {
		return nil, repository.ErrInvalidInput
	}
	var record models.AgentOperation
	if err := r.db.WithContext(ctx).Where("owner_user_id = ? AND operation_id = ?", owner, id).First(&record).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	item := toDomain(record)
	return &item, nil
}

func (r *Repo) Approve(ctx context.Context, owner uint, id string, revision uint64, approval domain.Approval) error {
	item, err := r.Get(ctx, owner, id)
	if err != nil {
		return err
	}
	if item.Revision != revision {
		return repository.ErrConflict
	}
	if item.Status != domain.Pending && !(item.Status == domain.Uncertain && domain.CanTransition(item.Kind, domain.Uncertain, domain.Running)) {
		return domain.ErrTransition
	}
	if err := approval.Validate(item.Spec, time.Now().UTC()); err != nil {
		return err
	}
	return changed(r.db.WithContext(ctx).Model(&models.AgentOperation{}).Where("owner_user_id = ? AND operation_id = ? AND revision = ? AND status = ?", owner, id, revision, item.Status).Updates(map[string]any{
		"approval_parameters_hash": approval.ParametersHash, "approval_workspace_version": approval.WorkspaceVersion, "approval_permission_scope": approval.PermissionScope, "approval_granted_at": approval.GrantedAt, "approval_expires_at": approval.ExpiresAt, "revision": gorm.Expr("revision + 1"),
	}))
}

func (r *Repo) Transition(ctx context.Context, owner uint, id string, revision uint64, from, to domain.Status, binding domain.Binding, summary string) error {
	item, err := r.Get(ctx, owner, id)
	if err != nil {
		return err
	}
	if item.Revision != revision || item.Status != from {
		return repository.ErrConflict
	}
	if !domain.CanTransition(item.Kind, from, to) {
		return domain.ErrTransition
	}
	if len(summary) > 4096 {
		return repository.ErrInvalidInput
	}
	query := r.db.WithContext(ctx).Model(&models.AgentOperation{}).Where("owner_user_id = ? AND operation_id = ? AND revision = ? AND status = ?", owner, id, revision, from)
	if to == domain.Running {
		now := time.Now().UTC()
		if binding != item.Spec.Binding() || item.Approval == nil {
			return domain.ErrApproval
		}
		if err := item.Approval.Validate(item.Spec, now); err != nil {
			return err
		}
		query = query.Where("approval_expires_at > ? AND approval_granted_at <= ? AND approval_parameters_hash = ? AND approval_workspace_version = ? AND approval_permission_scope = ?", now, now, binding.ParametersHash, binding.WorkspaceVersion, binding.PermissionScope)
	}
	updates := map[string]any{"status": string(to), "revision": gorm.Expr("revision + 1"), "result_summary": summary}
	if to == domain.Running && item.Kind == domain.Command {
		// 固定租约大于隔离执行上限（120秒）与清理预算；不提供续约或接管。
		expiry := "CURRENT_TIMESTAMP + INTERVAL '5 minutes'"
		if r.db.Dialector.Name() == "sqlite" {
			expiry = "datetime(CURRENT_TIMESTAMP, '+5 minutes')"
		}
		updates["lease_owner"] = r.owner
		updates["lease_expires_at"] = gorm.Expr(expiry)
	}
	if from == domain.Running && item.LeaseOwner != "" {
		query = query.Where("lease_owner = ? AND lease_expires_at > CURRENT_TIMESTAMP", r.owner)
	}
	return changed(query.Updates(updates))
}

func changed(result *gorm.DB) error {
	if result.Error != nil {
		return dberror.Translate(result.Error)
	}
	if result.RowsAffected != 1 {
		return repository.ErrConflict
	}
	return nil
}

func toDomain(record models.AgentOperation) domain.Operation {
	item := domain.Operation{LeaseOwner: record.LeaseOwner, LeaseExpiresAt: record.LeaseExpiresAt, Spec: domain.Spec{OwnerUserID: record.OwnerUserID, OperationID: record.OperationID, RunID: record.RunID, WorkspaceID: record.WorkspaceID, Kind: domain.Kind(record.Kind), ParametersHash: record.ParametersHash, ExpectedWorkspaceVersion: record.ExpectedWorkspaceVersion, PermissionScope: record.PermissionScope}, Status: domain.Status(record.Status), Revision: record.Revision, ResultSummary: record.ResultSummary, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
	if record.ApprovalGrantedAt != nil && record.ApprovalExpiresAt != nil {
		item.Approval = &domain.Approval{Binding: domain.Binding{ParametersHash: record.ApprovalParametersHash, WorkspaceVersion: record.ApprovalWorkspaceVersion, PermissionScope: record.ApprovalPermissionScope}, GrantedAt: *record.ApprovalGrantedAt, ExpiresAt: *record.ApprovalExpiresAt}
	}
	return item
}
