package repository

import (
	"context"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
)

// AgentOperationReconciliationRepository 是内部核对接口，不向用户提供系统范围查询。
type AgentOperationReconciliationRepository interface {
	ListExpiredRunning(ctx context.Context, ownerUserID uint, limit int) ([]agentoperation.Operation, error)
	MarkExpiredUncertain(ctx context.Context, snapshot agentoperation.Operation) error
}

// AgentOperationRepository 仅持久化操作及审批，不执行操作。
// 调用方负责验证用户对Run/Workspace的所有权并提供实时版本和权限scope。
type AgentOperationRepository interface {
	Create(ctx context.Context, spec agentoperation.Spec) (*agentoperation.Operation, error)
	Get(ctx context.Context, ownerUserID uint, operationID string) (*agentoperation.Operation, error)
	Approve(ctx context.Context, ownerUserID uint, operationID string, revision uint64, approval agentoperation.Approval) error
	Transition(ctx context.Context, ownerUserID uint, operationID string, revision uint64, from, to agentoperation.Status, binding agentoperation.Binding, resultSummary string) error
}
