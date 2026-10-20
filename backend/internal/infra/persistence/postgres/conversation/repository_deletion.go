package conversation

import (
	"context"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/dberror"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func lockWritableWorkspace(tx *gorm.DB, user, id uint) error {
	var workspace models.ProjectWorkspace
	return tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_user_id = ? AND status = ?", id, user, model.ProjectWorkspaceStatusActive).First(&workspace).Error
}

func (r *Repo) BeginConversationDeletion(ctx context.Context, user uint, publicID string) ([]model.Conversation, error) {
	var item models.Conversation
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ? AND public_id = ?", user, publicID).First(&item).Error; err != nil {
			return err
		}
		if err := tx.Model(&models.ProjectWorkspace{}).Where("owner_user_id = ? AND conversation_id = ? AND conversation_project_id IS NULL", user, item.ID).Update("status", "deleting").Error; err != nil {
			return err
		}
		return tx.Model(&item).Update("status", "deleting").Error
	})
	if err != nil {
		return nil, dberror.Translate(err)
	}
	return []model.Conversation{toConversationDomain(item)}, nil
}

func (r *Repo) BeginProjectDeletion(ctx context.Context, user uint, publicID string) ([]model.Conversation, error) {
	var items []models.Conversation
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var project models.ConversationProject
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ? AND public_id = ?", user, publicID).First(&project).Error; err != nil {
			return err
		}
		if err := tx.Model(&models.ProjectWorkspace{}).Where("owner_user_id = ? AND conversation_project_id = ?", user, project.ID).Update("status", "deleting").Error; err != nil {
			return err
		}
		if err := tx.Model(&project).Update("status", "deleting").Error; err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ? AND project_id = ?", user, project.ID).Find(&items).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, dberror.Translate(err)
	}
	result := make([]model.Conversation, 0, len(items))
	for _, item := range items {
		result = append(result, toConversationDomain(item))
	}
	return result, nil
}
