package repository

import (
	"context"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
)

// ConversationDeletionRepository 在停止执行前持久撤权；重复请求可继续处理 deleting 墓碑。
type ConversationDeletionRepository interface {
	BeginConversationDeletion(context.Context, uint, string) ([]model.Conversation, error)
	BeginProjectDeletion(context.Context, uint, string) ([]model.Conversation, error)
}
