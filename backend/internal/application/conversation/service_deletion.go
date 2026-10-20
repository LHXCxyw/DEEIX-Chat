package conversation

import (
	"context"
	"errors"
	"time"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/apperr"
)

var ErrDeletionPending = apperr.New("conversation.deletion_pending", "删除等待执行停止确认，请稍后重试；未物理清理文件")

func (s *Service) beginDeletion(ctx context.Context, user uint, publicID string, project bool) error {
	repo, ok := s.repo.(repository.ConversationDeletionRepository)
	if !ok {
		return ErrDeletionPending
	}
	var items []model.Conversation
	var err error
	if project {
		items, err = repo.BeginProjectDeletion(ctx, user, publicID)
	} else {
		items, err = repo.BeginConversationDeletion(ctx, user, publicID)
	}
	if err != nil {
		return err
	}
	targets := make(map[string]bool, len(items))
	for _, item := range items {
		targets[item.PublicID] = true
	}
	if err := s.stopDeletedGenerations(ctx, user, targets); err != nil {
		return err
	}
	for _, runtime := range []*agentCommandRuntime{s.agentRuntime, s.screenshotRuntime, s.projectBrowserRuntime} {
		if runtime == nil {
			continue
		}
		observer, ok := runtime.repo.(repository.AgentCommandSlotObserver)
		if !ok {
			return ErrDeletionPending
		}
		slots, err := observer.ListOccupiedCommandSlots(ctx)
		if err != nil {
			return errors.Join(ErrDeletionPending, err)
		}
		for _, slot := range slots {
			if slot.OwnerUserID == user {
				return ErrDeletionPending
			}
		}
	}
	return nil
}

func (s *Service) registerDeletionSafeGeneration(ctx context.Context, runID string, user uint, publicID string, cancel context.CancelFunc) error {
	if err := s.generationStreams.register(ctx, runID, user, publicID, cancel); err != nil {
		return err
	}
	if _, err := s.repo.GetConversationByPublicID(ctx, publicID, user); err != nil {
		cancel()
		s.FinishMessageGeneration(ctx, runID)
		return err
	}
	return nil
}

func (s *Service) stopDeletedGenerations(ctx context.Context, user uint, targets map[string]bool) error {
	r := s.generationStreams
	if r == nil {
		return nil
	}
	waitCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		runs := make(map[string]bool)
		r.mu.Lock()
		for id, active := range r.executing {
			if active.userID == user && targets[active.conversationID] {
				runs[id] = true
				if active.cancel != nil {
					active.cancel()
				}
			}
		}
		r.mu.Unlock()
		if r.store != nil {
			stored, err := r.store.ListActiveGenerationStreams(waitCtx, user)
			if err != nil {
				return errors.Join(ErrDeletionPending, err)
			}
			for _, active := range stored {
				if targets[active.ConversationPublicID] {
					runs[active.RunID] = true
				}
			}
		}
		if len(runs) == 0 {
			return nil
		}
		for id := range runs {
			if !r.cancel(waitCtx, user, id) {
				return ErrDeletionPending
			}
		}
		select {
		case <-waitCtx.Done():
			return ErrDeletionPending
		case <-time.After(25 * time.Millisecond):
		}
	}
}
