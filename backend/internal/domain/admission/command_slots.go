package admission

import (
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"time"
)

// CommandSlotSnapshot 仅供受信控制平面使用，禁止直接序列化到 HTTP。
type CommandSlotSnapshot struct {
	Identity            runtime.ContainerIdentity `json:"-" gorm:"embedded;embeddedPrefix:container_"`
	OperationRunID      string
	Slot                int
	OwnerUserID         uint
	OperationID         string
	Token               string `json:"-"`
	LeaseUntil          time.Time
	OperationStatus     string
	OperationRevision   uint64
	OperationLeaseUntil *time.Time
	OperationLeaseOwner string `json:"-"`
}
