package admission

import "errors"

var ErrBusy = errors.New("busy: 命令资源已占用或存在未确认清理的租约，未自动排队")

// Lease 仅允许持有随机令牌的执行方在确认容器清理后释放。
type Lease struct {
	Slot        int
	OwnerUserID uint
	OperationID string
	Token       string
}
