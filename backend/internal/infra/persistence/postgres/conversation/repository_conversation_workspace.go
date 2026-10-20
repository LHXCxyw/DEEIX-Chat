package conversation

import (
	"context"

	domainconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repo) GetOrCreateConversationWorkspace(ctx context.Context, ownerUserID uint, conversationID uint, publicID string) (*domainconversation.ProjectWorkspace, error) {
	var result models.ProjectWorkspace
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var conversation models.Conversation
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND user_id = ? AND project_id IS NULL AND status <> ?", conversationID, ownerUserID, "deleting").First(&conversation).Error; err != nil {
			return err
		}
		workspace := models.ProjectWorkspace{PublicID: publicID, OwnerUserID: ownerUserID, ConversationID: &conversationID, Status: domainconversation.ProjectWorkspaceStatusActive}
		if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_user_id"}, {Name: "conversation_id"}}, DoNothing: true}).Create(&workspace).Error; err != nil {
			return err
		}
		return tx.Where("owner_user_id = ? AND conversation_id = ? AND conversation_project_id IS NULL", ownerUserID, conversationID).First(&result).Error
	})
	if err != nil {
		return nil, dberror.Translate(err)
	}
	value := toProjectWorkspaceDomain(result)
	return &value, nil
}

func (r *Repo) GetConversationWorkspace(ctx context.Context, ownerUserID uint, conversationID uint) (*domainconversation.ProjectWorkspace, error) {
	var conversation models.Conversation
	if err := r.db.WithContext(ctx).Where("id = ? AND user_id = ? AND project_id IS NULL AND status <> ?", conversationID, ownerUserID, "deleting").First(&conversation).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	var result models.ProjectWorkspace
	if err := r.db.WithContext(ctx).Where("owner_user_id = ? AND conversation_id = ? AND conversation_project_id IS NULL", ownerUserID, conversationID).First(&result).Error; err != nil {
		return nil, dberror.Translate(err)
	}
	value := toProjectWorkspaceDomain(result)
	return &value, nil
}
