package agentoperation

import (
	"context"
	"time"
)

// ExpiredLeaseStore 使用持久化时钟核对，不能以本进程启动时间替代租约到期。
type ExpiredLeaseStore interface {
	ReconcileExpired(context.Context) (int64, error)
}

type Reconciler struct{ Store ExpiredLeaseStore }

func (r Reconciler) Reconcile(ctx context.Context) (int64, error) {
	if r.Store == nil {
		return 0, ErrInvalid
	}
	return r.Store.ReconcileExpired(ctx)
}

// Run 周期核对只改变过期操作的状态，既不恢复执行，也不宣称容器已回收。
func (r Reconciler) Run(ctx context.Context, interval time.Duration, report func(int64, error)) error {
	if r.Store == nil || interval <= 0 {
		return ErrInvalid
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			n, err := r.Reconcile(checkCtx)
			cancel()
			if report != nil {
				report(n, err)
			}
		}
	}
}
