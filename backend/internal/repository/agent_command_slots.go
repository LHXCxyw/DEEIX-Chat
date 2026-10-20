package repository

import (
	"context"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

// AgentCommandSlotObserver 不授予释放租约或修改 operation 的权限。
type AgentCommandSlotRecoveryRepository interface {
	AgentCommandSlotObserver
	BindCommandContainer(context.Context, admission.Lease, uint64, runtime.ContainerIdentity) error
	ReleaseRecoveredCommandSlot(context.Context, admission.CommandSlotSnapshot) error
}

type AgentCommandSlotObserver interface {
	ListOccupiedCommandSlots(context.Context) ([]admission.CommandSlotSnapshot, error)
}
