package repository

import (
	"context"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
)

type AgentCommandAdmissionRepository interface {
	AcquireCommandLease(ctx context.Context, ownerUserID uint, operationID string) (admission.Lease, error)
	ReleaseCommandLease(ctx context.Context, lease admission.Lease) error
}

// AgentCommandSlotReclaimer 只允许回收“租约已过期且从未绑定容器”的残留槽位；
// 存在未知容器身份的租约必须继续走管理端核对，不能被自动释放。
type AgentCommandSlotReclaimer interface {
	ReleaseStaleCommandLeases(ctx context.Context) (int64, error)
}
