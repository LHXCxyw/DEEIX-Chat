package conversation

import (
	"context"
	"time"

	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/background"
	"go.uber.org/zap"
)

// agentSlotReclaimInterval 是残留槽位回收周期；启动时立即执行一次，覆盖跨重启残留。
const agentSlotReclaimInterval = time.Minute

func (s *Service) agentRuntimes() []*agentCommandRuntime {
	if s == nil {
		return nil
	}
	runtimes := make([]*agentCommandRuntime, 0, 3)
	for _, r := range []*agentCommandRuntime{s.agentRuntime, s.screenshotRuntime, s.projectBrowserRuntime} {
		if r != nil && r.repo != nil && r.executor != nil {
			runtimes = append(runtimes, r)
		}
	}
	return runtimes
}

// StartAgentSlotReclaimWorker 启动槽位回收 worker：启动时立即回收一次，之后每分钟一次。
// 该 worker 只处理“租约已过期”的残留，不会释放正在执行的租约。
func (s *Service) StartAgentSlotReclaimWorker(ctx context.Context) {
	if s == nil || len(s.agentRuntimes()) == 0 {
		return
	}
	background.Go(s.logger, "agent_slot_reclaim", func() {
		s.reclaimAgentSlots(ctx)
		ticker := time.NewTicker(agentSlotReclaimInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.reclaimAgentSlots(ctx)
			}
		}
	})
}

func (s *Service) reclaimAgentSlots(ctx context.Context) {
	released, recovered := s.ReclaimStaleAgentSlots(ctx)
	if released > 0 || recovered > 0 {
		s.agentLogger().Info("agent_slot_reclaimed",
			zap.Int("released_unbound", released),
			zap.Int("recovered_container", recovered))
	}
}

func (s *Service) agentLogger() *zap.Logger {
	if s == nil || s.logger == nil {
		return zap.NewNop()
	}
	return s.logger
}

// ReclaimStaleAgentSlots 回收过期残留：
//  1. 从未绑定容器的槽位直接释放（无容器需要核对）；
//  2. 已绑定容器、操作已为 uncertain 且租约过期的，先按可信容器身份核对并删除容器，再释放槽位。
//
// 返回释放的未绑定槽位数量与完成容器回收的槽位数量。
func (s *Service) ReclaimStaleAgentSlots(ctx context.Context) (int, int) {
	runtimes := s.agentRuntimes()
	if len(runtimes) == 0 {
		return 0, 0
	}
	log := s.agentLogger()
	released := 0
	for _, r := range runtimes {
		reclaimer, ok := r.admission.(repository.AgentCommandSlotReclaimer)
		if !ok {
			continue
		}
		n, err := reclaimer.ReleaseStaleCommandLeases(ctx)
		if err != nil {
			log.Warn("agent_slot_reclaim_unbound_failed", zap.Error(err))
		} else {
			released += int(n)
		}
		// 三个执行器共享同一张槽位表，只需回收一次。
		break
	}
	observer, ok := runtimes[0].repo.(repository.AgentCommandSlotObserver)
	if !ok {
		return released, 0
	}
	slots, err := observer.ListOccupiedCommandSlots(ctx)
	if err != nil {
		log.Warn("agent_slot_reclaim_list_failed", zap.Error(err))
		return released, 0
	}
	now := time.Now().UTC()
	recovered := 0
	for _, slot := range slots {
		if slot.Identity.ID == "" || slot.OperationStatus != "uncertain" || slot.LeaseUntil.After(now) {
			continue
		}
		if slot.OperationLeaseUntil != nil && slot.OperationLeaseUntil.After(now) {
			continue
		}
		if !recoverSlotContainer(ctx, runtimes, slot.Identity) {
			continue
		}
		store, ok := runtimes[0].repo.(repository.AgentCommandSlotRecoveryRepository)
		if !ok {
			continue
		}
		if err := store.ReleaseRecoveredCommandSlot(ctx, slot); err != nil {
			log.Warn("agent_slot_release_failed", zap.String("operation_id", slot.OperationID), zap.Error(err))
			continue
		}
		recovered++
	}
	return released, recovered
}

// recoverSlotContainer 依次尝试各执行节点核对并删除容器。
// 只有创建该容器的执行节点能通过 owner 标签校验，其余节点会拒绝且不会删除任何容器。
func recoverSlotContainer(ctx context.Context, runtimes []*agentCommandRuntime, identity runtime.ContainerIdentity) bool {
	for _, r := range runtimes {
		recoverer, ok := r.executor.(runtime.Recoverer)
		if !ok {
			continue
		}
		if err := recoverer.RecoverContainer(ctx, identity); err == nil {
			return true
		}
	}
	return false
}
