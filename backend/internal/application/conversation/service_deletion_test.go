package conversation

import (
	"context"
	"errors"
	"testing"
	"time"

	cachememory "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/cache/memory"
)

func TestDeletionWaitsForExecutionNotLeaseWorker(t *testing.T) {
	r := newGenerationStreamRegistry(cachememory.New(), defaultGenerationStreamOptions())
	defer r.close()
	canceled := make(chan struct{}, 1)
	ctx, release := registerTestGeneration(t, r, "run_delete", 1, "chat", func() {
		select {
		case canceled <- struct{}{}:
		default:
		}
	})
	defer release()
	active := r.localActive("run_delete")
	r.removeActiveExecution("run_delete", active)
	stopActiveWorker(active)
	s := &Service{generationStreams: r}
	waitCtx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := s.stopDeletedGenerations(waitCtx, 1, map[string]bool{"chat": true}); !errors.Is(err, ErrDeletionPending) {
		t.Fatalf("执行未退出却允许删除: %v", err)
	}
	select {
	case <-canceled:
	default:
		t.Fatal("未请求取消")
	}
	r.finish(ctx, "run_delete")
	// 租约仍在时也必须保守阻断；完成租约后才允许重试。
	r.finalizeGeneration(context.Background(), "run_delete", active)
	if err := s.stopDeletedGenerations(context.Background(), 1, map[string]bool{"chat": true}); err != nil {
		t.Fatal(err)
	}
}

func TestDeletionPropagatesCancelAcrossRegistries(t *testing.T) {
	store := cachememory.New()
	owner := newGenerationStreamRegistry(store, generationStreamOptions{LeaseTTL: time.Second, LeaseRefresh: 10 * time.Millisecond})
	deleter := newGenerationStreamRegistry(store, defaultGenerationStreamOptions())
	defer owner.close()
	defer deleter.close()
	canceled := make(chan struct{}, 1)
	_, release := registerTestGeneration(t, owner, "run_remote", 1, "chat", func() {
		select {
		case canceled <- struct{}{}:
		default:
		}
	})
	defer release()
	s := &Service{generationStreams: deleter}
	waitCtx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if err := s.stopDeletedGenerations(waitCtx, 1, map[string]bool{"chat": true}); !errors.Is(err, ErrDeletionPending) {
		t.Fatalf("未退出应 pending: %v", err)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("跨实例取消未传播到执行上下文")
	}
	release()
	if err := s.stopDeletedGenerations(context.Background(), 1, map[string]bool{"chat": true}); err != nil {
		t.Fatal(err)
	}
}
