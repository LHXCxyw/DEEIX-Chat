package repository

import (
	"context"
	"time"
)

type ToolApproval struct {
	Mode                 string    `json:"mode"`
	ID                   string    `json:"id" gorm:"primaryKey;size:80"`
	UserID               uint      `json:"-" gorm:"index"`
	ConversationID       uint      `json:"conversation_id"`
	ConversationPublicID string    `json:"conversation_public_id" gorm:"->;-:migration"`
	RunID                string    `json:"run_id"`
	ToolCallID           string    `json:"tool_call_id"`
	ToolName             string    `json:"tool_name"`
	ArgumentsJSON        string    `json:"arguments_json"`
	ParametersHash       string    `json:"parameters_hash"`
	WorkspaceVersion     string    `json:"workspace_version"`
	Status               string    `json:"status" gorm:"index"`
	ExpiresAt            time.Time `json:"expires_at"`
	CreatedAt            time.Time `json:"created_at"`
}

type ToolApprovalRepository interface {
	CreateToolApproval(context.Context, *ToolApproval) error
	GetToolApproval(context.Context, uint, string) (*ToolApproval, error)
	ListToolApprovals(context.Context, uint) ([]ToolApproval, error)
	ChangeToolApproval(context.Context, uint, string, string, string) error
}
