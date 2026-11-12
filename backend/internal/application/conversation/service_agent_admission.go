package conversation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

const (
	// agentSlotWaitTimeout 是一次工具调用在槽位繁忙时的最长等待时间。
	// 超过该时间仍未取得槽位才返回错误；命令与浏览器共用同一组槽位，等待可避免
	// 同一用户连续调用时必然失败。
	agentSlotWaitTimeout = 90 * time.Second
	// agentSlotWaitInterval 是重试间隔；期间顺带回收过期未绑定的残留租约。
	agentSlotWaitInterval = 500 * time.Millisecond
	// agentSlotReclaimThrottle 是等待期间回收残留租约的最小间隔，避免繁忙时频繁写库。
	agentSlotReclaimThrottle = 5 * time.Second
)

// acquireAgentCommandLease 在槽位繁忙时进行有界等待。
// 等待期间会回收“过期且从未绑定容器”的残留租约，使异常中断后能自动恢复可用性。
func (s *Service) acquireAgentCommandLease(ctx context.Context, r *agentCommandRuntime, ownerUserID uint, operationID string) (admission.Lease, error) {
	deadline := time.Now().Add(agentSlotWaitTimeout)
	nextReclaim := time.Now()
	for {
		lease, err := r.admission.AcquireCommandLease(ctx, ownerUserID, operationID)
		if err == nil {
			return lease, nil
		}
		if !errors.Is(err, admission.ErrBusy) {
			return admission.Lease{}, err
		}
		if reclaimer, ok := r.admission.(repository.AgentCommandSlotReclaimer); ok && !time.Now().Before(nextReclaim) {
			_, _ = reclaimer.ReleaseStaleCommandLeases(ctx)
			nextReclaim = time.Now().Add(agentSlotReclaimThrottle)
		}
		if !time.Now().Before(deadline) {
			return admission.Lease{}, fmt.Errorf("%w：已等待 %s 仍未取得执行槽位（全局 2 个、每用户 1 个），本次未执行；请稍后重试或等待当前任务结束", admission.ErrBusy, agentSlotWaitTimeout)
		}
		timer := time.NewTimer(agentSlotWaitInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return admission.Lease{}, ctx.Err()
		case <-timer.C:
		}
	}
}

// runAgentExecutor 隔离执行器 panic：崩溃可能发生在容器创建与身份绑定之间，
// 调用方必须保持租约（fail closed），不能把未知状态的槽位放回池中复用。
func runAgentExecutor(ctx context.Context, executor runtime.Executor, request runtime.Request) (result runtime.Result, err error, panicked any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			panicked = recovered
		}
	}()
	result, err = executor.Execute(ctx, request)
	return result, err, nil
}
