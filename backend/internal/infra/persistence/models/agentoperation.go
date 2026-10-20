package models

import "time"

// AgentOperation 不使用软删除，避免遗失幂等键和重复执行。
type AgentOperation struct {
	ControlPlaneModel
	OperationID              string `gorm:"size:128;not null;uniqueIndex:idx_agent_operations_operation_id"`
	OwnerUserID              uint   `gorm:"not null;index:idx_agent_operations_owner"`
	RunID                    string `gorm:"size:64;not null;index"`
	WorkspaceID              uint   `gorm:"not null;index"`
	Kind                     string `gorm:"size:32;not null"`
	ParametersHash           string `gorm:"size:64;not null"`
	ExpectedWorkspaceVersion string `gorm:"size:128;not null"`
	PermissionScope          string `gorm:"size:256;not null"`
	Status                   string `gorm:"size:24;not null"`
	LeaseOwner               string `gorm:"size:64;not null;default:''"`
	LeaseExpiresAt           *time.Time `gorm:"index:idx_agent_operations_lease_expiry"`
	Revision                 uint64 `gorm:"not null"`
	ApprovalParametersHash   string `gorm:"size:64;not null;default:''"`
	ApprovalWorkspaceVersion string `gorm:"size:128;not null;default:''"`
	ApprovalPermissionScope  string `gorm:"size:256;not null;default:''"`
	ApprovalGrantedAt        *time.Time
	ApprovalExpiresAt        *time.Time
	ResultSummary            string `gorm:"type:text;not null;default:''"`
}

func (AgentOperation) TableName() string { return "chat_agent_operations" }
