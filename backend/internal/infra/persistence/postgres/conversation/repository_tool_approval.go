package conversation

import (
	"context"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func (r *Repo) CreateToolApproval(ctx context.Context, item *repository.ToolApproval) error {
	return translateError(r.db.WithContext(ctx).Create(item).Error)
}
func (r *Repo) GetToolApproval(ctx context.Context, user uint, id string) (*repository.ToolApproval, error) {
	var item repository.ToolApproval
	err := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", id, user).First(&item).Error
	return &item, translateError(err)
}
func (r *Repo) ListToolApprovals(ctx context.Context, user uint) ([]repository.ToolApproval, error) {
	items := []repository.ToolApproval{}
	err := r.db.WithContext(ctx).Model(&repository.ToolApproval{}).
		Select("tool_approvals.*, c.public_id AS conversation_public_id").
		Joins("JOIN chat_conversations c ON c.id = tool_approvals.conversation_id AND c.user_id = tool_approvals.user_id AND c.deleted_at IS NULL AND c.status <> ?", "deleting").
		Joins("LEFT JOIN chat_conversation_projects p ON p.id = c.project_id AND p.user_id = c.user_id AND p.deleted_at IS NULL AND p.status <> ?", "deleting").
		Where("tool_approvals.user_id = ? AND tool_approvals.status = ? AND tool_approvals.expires_at > ?", user, "pending", time.Now().UTC()).
		Where("c.project_id IS NULL OR p.id IS NOT NULL").
		Order("tool_approvals.created_at ASC").Limit(100).Find(&items).Error
	return items, translateError(err)
}
func (r *Repo) ChangeToolApproval(ctx context.Context, user uint, id, from, to string) error {
	query := r.db.WithContext(ctx).Model(&repository.ToolApproval{}).Where("id = ? AND user_id = ? AND status = ?", id, user, from)
	if to == "approved" || to == "consumed" {
		query = query.Where("expires_at > ?", time.Now().UTC())
	}
	result := query.Update("status", to)
	if result.Error != nil {
		return translateError(result.Error)
	}
	if result.RowsAffected != 1 {
		return repository.ErrConflict
	}
	return nil
}
