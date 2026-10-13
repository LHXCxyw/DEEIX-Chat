package conversation

import (
	"context"
	"errors"
	"path"
	"strings"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/google/uuid"
)

// rewindAncestorMaxDepth 限制回退定位的祖先链长度，与 fork 的递归 CTE 上限对齐。
const rewindAncestorMaxDepth = 2000

// 回退对文件的动作类型。
const (
	RewindFileActionRestore = "restore" // 恢复历史内容覆盖当前内容
	RewindFileActionCreate  = "create"  // 当前不存在，恢复历史文件
	RewindFileActionDelete  = "delete"  // 目标时点不存在，移除当前文件
)

// ConversationRewindPreviewItem 描述回退确认清单中的一个受影响文件。
// json 契约由 transport 层 Doc DTO 承载，这里保持应用层类型纯净。
type ConversationRewindPreviewItem struct {
	RelativePath    string
	Action          string
	CurrentVersion  int
	TargetVersion   int
	TargetSizeBytes int64
}

// ConversationRewindPreview 描述一次消息回退将产生的全部影响，供前端确认。
type ConversationRewindPreview struct {
	MessagePublicID string
	HasProjectFiles bool
	Items           []ConversationRewindPreviewItem
}

// ConversationRewindResult 描述回退执行结果。
type ConversationRewindResult struct {
	Conversation *model.Conversation
	Items        []ConversationRewindPreviewItem
	TipPublicID  string
}

// rewindFilePlan 汇总一次回退的文件侧计算结果。
type rewindFilePlan struct {
	workspace *model.ProjectWorkspace
	actions   []ConversationRewindPreviewItem
	// restoreTargets 记录 action 为 restore/create 的目标快照，按路径索引。
	restoreTargets map[string]model.ProjectFileSnapshot
	// deleteTargets 记录 action 为 delete 的当前活文件，按路径索引。
	deleteTargets map[string]model.ProjectFile
	// liveByPath 计算计划时的活跃文件快照（仅 file 节点），apply 阶段复用，
	// 避免重复查询与两次查询之间的状态漂移。
	liveByPath map[string]model.ProjectFile
}

// PreviewConversationRewind 计算回退到指定消息将产生的影响，不做任何变更。
func (s *Service) PreviewConversationRewind(ctx context.Context, userID uint, conversationPublicID string, messagePublicID string) (*ConversationRewindPreview, error) {
	plan, err := s.prepareConversationRewind(ctx, userID, conversationPublicID, messagePublicID)
	if err != nil {
		return nil, err
	}
	return &ConversationRewindPreview{
		MessagePublicID: messagePublicID,
		HasProjectFiles: plan.workspace != nil,
		Items:           plan.actions,
	}, nil
}

// RewindConversationToMessage 将会话截断到指定消息（保留其后消息为非当前分支），
// 并把项目工作区文件恢复到该消息完成时的状态。回退自身记入文件变更日志，
// 因此回退之后仍可再次回退到更晚的时点。
func (s *Service) RewindConversationToMessage(ctx context.Context, userID uint, conversationPublicID string, messagePublicID string) (*ConversationRewindResult, error) {
	plan, err := s.prepareConversationRewind(ctx, userID, conversationPublicID, messagePublicID)
	if err != nil {
		return nil, err
	}

	if err = s.applyRewindFilePlan(ctx, userID, plan); err != nil {
		return nil, err
	}

	// 祖先链与消息在 prepare 阶段已校验，这里只回填续聊锚点。
	if err = s.repo.UpdateConversationActiveTip(ctx, plan.conversation.ID, plan.message.ID, plan.message.PublicID); err != nil {
		return nil, err
	}

	plan.conversation.ActiveTipMessageID = plan.message.ID
	plan.conversation.ActiveTipMessagePublicID = plan.message.PublicID
	return &ConversationRewindResult{
		Conversation: plan.conversation,
		Items:        plan.actions,
		TipPublicID:  plan.message.PublicID,
	}, nil
}

// rewindPlan 承载 prepare 阶段的全部校验与计算结果。
type rewindPlan struct {
	conversation *model.Conversation
	message      *model.Message
	rewindFilePlan
}

// prepareConversationRewind 校验回退目标并计算文件恢复计划：
// 以目标消息完成时间为时点 T，"目标状态" = 每个路径在 T 时刻（含）前最后一次变更的结果；
// T 之后发生过的变更（无论来自哪个会话）都会被回退覆盖，符合时点快照语义。
func (s *Service) prepareConversationRewind(ctx context.Context, userID uint, conversationPublicID string, messagePublicID string) (*rewindPlan, error) {
	normalizedConversationID := strings.TrimSpace(conversationPublicID)
	if normalizedConversationID == "" {
		return nil, ErrConversationNotFound
	}
	normalizedMessageID := strings.TrimSpace(messagePublicID)
	if normalizedMessageID == "" {
		return nil, ErrMessageNotFound
	}

	conversation, err := s.repo.GetConversationByPublicID(ctx, normalizedConversationID, userID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationNotFound
		}
		return nil, err
	}

	message, err := s.repo.GetMessageByPublicIDForUser(ctx, userID, normalizedMessageID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrMessageNotFound
		}
		return nil, err
	}
	if message.ConversationID != conversation.ID {
		return nil, ErrMessageNotFound
	}
	// 存在进行中的生成时拒绝回退：pending 消息尚未定稿、变更日志仍在追加，
	// 此时回退的时点语义是未定义的。
	if pending, err := s.repo.HasPendingMessageInConversation(ctx, conversation.ID); err != nil {
		return nil, err
	} else if pending {
		return nil, ErrMessageRewindStateInvalid
	}
	if message.Status == "pending" {
		return nil, ErrMessageRewindStateInvalid
	}

	ancestors, err := s.repo.ListMessageAncestors(ctx, conversation.ID, message.ID, rewindAncestorMaxDepth)
	if err != nil {
		return nil, err
	}
	if len(ancestors) == 0 || ancestors[len(ancestors)-1].ID != message.ID {
		return nil, ErrMessageRewindHistoryIncomplete
	}

	plan := &rewindPlan{
		conversation: conversation,
		message:      message,
		rewindFilePlan: rewindFilePlan{
			restoreTargets: map[string]model.ProjectFileSnapshot{},
			deleteTargets:  map[string]model.ProjectFile{},
			liveByPath:     map[string]model.ProjectFile{},
		},
	}

	if conversation.ProjectID == nil {
		return plan, nil
	}
	workspace, err := s.repo.GetProjectWorkspaceByProject(ctx, userID, *conversation.ProjectID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			// 空项目可能尚未创建工作区：无文件可回退，仅做消息截断。
			return plan, nil
		}
		return nil, err
	}
	plan.workspace = workspace

	// 时点 T 需要一个不会被后续更新推后的稳定锚点：assistant 消息绑定 run，
	// 用 run.EndedAt（仅落一次）；无 run 的消息（如用户消息）退回创建时间。
	// message.UpdatedAt 会被用量/计费回写持续 bump，不能作为锚点。
	boundary := message.CreatedAt
	if strings.TrimSpace(message.RunID) != "" {
		if run, runErr := s.repo.GetConversationRunByRunID(ctx, userID, message.RunID); runErr == nil {
			if run.EndedAt != nil && !run.EndedAt.IsZero() {
				boundary = *run.EndedAt
			} else {
				boundary = run.UpdatedAt
			}
		}
	}
	changesBefore, err := s.repo.ListProjectFileChanges(ctx, userID, workspace.ID, repository.ProjectFileChangeListFilter{CreatedAtOrBefore: &boundary})
	if err != nil {
		return nil, err
	}
	changesAfter, err := s.repo.ListProjectFileChanges(ctx, userID, workspace.ID, repository.ProjectFileChangeListFilter{CreatedAtAfter: &boundary})
	if err != nil {
		return nil, err
	}

	// 沿日志顺序重放得到 T 时刻的目标状态；后写的记录覆盖先写的。
	target := make(map[string]model.ProjectFileSnapshot, len(changesBefore))
	for _, change := range changesBefore {
		target[change.RelativePath] = change.After
	}
	changedAfter := make(map[string]struct{}, len(changesAfter))
	for _, change := range changesAfter {
		changedAfter[change.RelativePath] = struct{}{}
	}

	liveFiles, err := s.repo.ListProjectFiles(ctx, userID, workspace.ID)
	if err != nil {
		return nil, err
	}

	plan.actions, plan.restoreTargets, plan.deleteTargets, plan.liveByPath = computeRewindFileActions(target, changedAfter, liveFiles)
	return plan, nil
}

// computeRewindFileActions 根据"T 时刻目标状态 + T 之后的变更路径 + 当前活文件"
// 计算回退动作清单。目标状态中不存在、但在 T 之后被改动过的文件：T 时刻尚未创建，
// 需删除；无任何日志痕迹的存量文件保持原样（保守策略，避免误删历史遗留内容）。
func computeRewindFileActions(
	target map[string]model.ProjectFileSnapshot,
	changedAfter map[string]struct{},
	liveFiles []model.ProjectFile,
) (actions []ConversationRewindPreviewItem, restoreTargets map[string]model.ProjectFileSnapshot, deleteTargets map[string]model.ProjectFile, liveByPath map[string]model.ProjectFile) {
	restoreTargets = map[string]model.ProjectFileSnapshot{}
	deleteTargets = map[string]model.ProjectFile{}
	liveByPath = map[string]model.ProjectFile{}
	for _, file := range liveFiles {
		if file.EntryType == model.ProjectFileEntryTypeFile {
			liveByPath[file.RelativePath] = file
		}
	}
	for targetPath, targetState := range target {
		liveFile, exists := liveByPath[targetPath]
		switch {
		case !exists:
			if targetState.Empty() {
				continue
			}
			actions = append(actions, ConversationRewindPreviewItem{
				RelativePath: targetPath, Action: RewindFileActionCreate,
				TargetVersion: targetState.Version + 1, TargetSizeBytes: targetState.SizeBytes,
			})
			restoreTargets[targetPath] = targetState
		case targetState.Empty():
			actions = append(actions, ConversationRewindPreviewItem{
				RelativePath: targetPath, Action: RewindFileActionDelete,
				CurrentVersion: liveFile.Version,
			})
			deleteTargets[targetPath] = liveFile
		case liveFile.StorageKey != targetState.StorageKey:
			actions = append(actions, ConversationRewindPreviewItem{
				RelativePath: targetPath, Action: RewindFileActionRestore,
				CurrentVersion: liveFile.Version, TargetVersion: liveFile.Version + 1,
				TargetSizeBytes: targetState.SizeBytes,
			})
			restoreTargets[targetPath] = targetState
		}
	}
	for livePath, liveFile := range liveByPath {
		if _, inTarget := target[livePath]; inTarget {
			continue
		}
		if _, touched := changedAfter[livePath]; !touched {
			continue
		}
		actions = append(actions, ConversationRewindPreviewItem{
			RelativePath: livePath, Action: RewindFileActionDelete,
			CurrentVersion: liveFile.Version,
		})
		deleteTargets[livePath] = liveFile
	}
	return actions, restoreTargets, deleteTargets, liveByPath
}

// applyRewindFilePlan 落盘文件恢复计划。内容对象一律保留在对象存储中
// （由变更日志引用），这里只切换数据库指针，保证"回退之后再回退"仍可推导。
// 回退事件本身也写入变更日志并关联目标消息，保证日志与文件实际状态始终一致。
func (s *Service) applyRewindFilePlan(ctx context.Context, userID uint, plan *rewindPlan) error {
	if plan.workspace == nil || len(plan.actions) == 0 {
		return nil
	}
	changeCtx := ProjectFileChangeContext{
		Source:         model.ProjectFileChangeSourceRewind,
		ConversationID: plan.conversation.ID,
		MessageID:      plan.message.ID,
		RunID:          plan.message.RunID,
	}
	var storageDelta int64
	fileDelta := 0
	liveByPath := plan.liveByPath
	var err error

	for _, action := range plan.actions {
		switch action.Action {
		case RewindFileActionRestore, RewindFileActionCreate:
			target := plan.restoreTargets[action.RelativePath]
			liveFile, exists := liveByPath[action.RelativePath]
			var after model.ProjectFileSnapshot
			if exists {
				updated, updateErr := s.repo.UpdateProjectFile(ctx, userID, plan.workspace.ID, liveFile.PublicID, target.StorageKey, target.MimeType, target.SizeBytes, target.SHA256, liveFile.Version+1)
				if updateErr != nil {
					return updateErr
				}
				after = projectFileSnapshot(updated)
				storageDelta += target.SizeBytes - liveFile.SizeBytes
			} else {
				if err = s.repo.PurgeProjectFileByPath(ctx, userID, plan.workspace.ID, action.RelativePath); err != nil {
					return err
				}
				item := &model.ProjectFile{
					PublicID: normalizePublicID(uuid.NewString()), OwnerUserID: userID, ProjectID: plan.workspace.ID,
					RelativePath: action.RelativePath, FileName: path.Base(action.RelativePath),
					EntryType: model.ProjectFileEntryTypeFile, StorageKey: target.StorageKey,
					MimeType: target.MimeType, SizeBytes: target.SizeBytes, SHA256: target.SHA256,
					Version: target.Version + 1,
				}
				if err = s.repo.CreateProjectFile(ctx, item); err != nil {
					return err
				}
				after = projectFileSnapshot(item)
				storageDelta += target.SizeBytes
				fileDelta++
			}
			if err = s.recordProjectFileChange(ctx, userID, plan.workspace.ID, changeCtx, action.RelativePath, model.ProjectFileChangeOpWrite, projectFileSnapshotOf(liveByPath[action.RelativePath], exists), after); err != nil {
				return err
			}
		case RewindFileActionDelete:
			liveFile := plan.deleteTargets[action.RelativePath]
			if _, err = s.repo.DeleteProjectFile(ctx, userID, plan.workspace.ID, liveFile.PublicID); err != nil {
				return err
			}
			if err = s.recordProjectFileChange(ctx, userID, plan.workspace.ID, changeCtx, action.RelativePath, model.ProjectFileChangeOpDelete, projectFileSnapshot(&liveFile), model.ProjectFileSnapshot{}); err != nil {
				return err
			}
			storageDelta -= liveFile.SizeBytes
			fileDelta--
		}
	}
	if storageDelta != 0 || fileDelta != 0 {
		if err = s.repo.UpdateProjectWorkspaceUsage(ctx, userID, plan.workspace.ID, storageDelta, fileDelta); err != nil {
			return err
		}
	}
	return nil
}

func projectFileSnapshotOf(file model.ProjectFile, exists bool) model.ProjectFileSnapshot {
	if !exists {
		return model.ProjectFileSnapshot{}
	}
	return projectFileSnapshot(&file)
}
