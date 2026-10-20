package agentoperation

import (
	"context"
	"errors"
	"testing"
	"time"
)

type leaseStoreFunc func(context.Context) (int64, error)

func (f leaseStoreFunc) ReconcileExpired(ctx context.Context) (int64, error) { return f(ctx) }

func TestReconcilerPeriodicCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	r := Reconciler{Store: leaseStoreFunc(func(ctx context.Context) (int64, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("缺少核对截止时间")
		}
		calls++
		return 1, nil
	})}
	err := r.Run(ctx, time.Millisecond, func(n int64, err error) {
		if n != 1 || err != nil {
			t.Errorf("核对结果: %d %v", n, err)
		}
		cancel()
	})
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("取消后仍核对: %d %v", calls, err)
	}
}

func TestReconcilerInvalid(t *testing.T) {
	if _, err := (Reconciler{}).Reconcile(context.Background()); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if err := (Reconciler{}).Run(context.Background(), 0, nil); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}
