package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

const (
	projectPreviewResultMaxLines = 200
	projectPreviewResultMaxChars = 4000
)

// RecordProjectPreviewResultInput 描述前端沙箱回写的项目预览运行结果。
type RecordProjectPreviewResultInput struct {
	UserID         uint
	ConversationID string // 会话 public_id
	RunID          string
	EntryPath      string
	Console        []string
	Errors         []string
}

// RecordProjectPreviewResult 把前端沙箱捕获的预览运行信息（console 与运行时错误）作为一条工具结果
// 持久化到会话，并写入上下文证据，使模型在下一轮可以读到预览运行情况并据此迭代。
//
// 落点说明：会话历史发送给模型时只保留消息 Role/Content，工具调用结果通过 tool_calls 记录 +
// tool_result 上下文证据（recallHistoricalContextArtifacts）在后续轮次召回。因此这里复用现有
// 工具调用持久化路径，写入 project_preview 的工具结果行并生成对应的上下文证据。
func (s *Service) RecordProjectPreviewResult(ctx context.Context, input RecordProjectPreviewResultInput) error {
	if s == nil || s.repo == nil {
		return fmt.Errorf("conversation service is unavailable")
	}
	conversation, err := s.repo.GetConversationByPublicID(ctx, strings.TrimSpace(input.ConversationID), input.UserID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return ErrConversationNotFound
		}
		return err
	}
	entryPath := strings.TrimSpace(input.EntryPath)
	if entryPath == "" {
		return fmt.Errorf("project preview: entry path is required")
	}
	messageID, runID := s.resolveProjectPreviewAnchor(ctx, input.UserID, conversation.ID, input.RunID)
	if messageID == 0 {
		// 尚无助手消息可挂载（例如会话为空）：静默跳过，不影响对话主流程。
		return nil
	}

	consoleLines := normalizeProjectPreviewLines(input.Console)
	errorLines := normalizeProjectPreviewLines(input.Errors)
	outputJSON, err := json.Marshal(map[string]interface{}{
		"entry_path": entryPath,
		"console":    consoleLines,
		"errors":     errorLines,
		"summary": fmt.Sprintf(
			"project preview ran %s: %d console line(s), %d error(s)",
			entryPath, len(consoleLines), len(errorLines),
		),
	})
	if err != nil {
		return err
	}
	inputJSON, err := json.Marshal(map[string]string{"path": entryPath})
	if err != nil {
		return err
	}

	row := model.ToolCall{
		ConversationID: conversation.ID,
		UserID:         input.UserID,
		MessageID:      messageID,
		RunID:          runID,
		ToolCallID:     "project-preview-result:" + uuid.NewString(),
		ToolType:       "function",
		ToolName:       "project_preview",
		Status:         "success",
		InputJSON:      string(inputJSON),
		OutputJSON:     string(outputJSON),
	}
	if err := s.repo.CreateConversationToolCall(ctx, &row); err != nil {
		return err
	}
	s.persistToolContextArtifacts(ctx, toolContextArtifactInput{
		ConversationID: conversation.ID,
		UserID:         input.UserID,
		MessageID:      messageID,
		RunID:          runID,
		Rows:           []model.ToolCall{row},
	})
	return nil
}

// resolveProjectPreviewAnchor 定位运行结果应挂载的助手消息：优先按 run_id 精确匹配，
// 回退到会话内最新的助手消息，并补齐 run_id。
func (s *Service) resolveProjectPreviewAnchor(ctx context.Context, userID uint, conversationID uint, rawRunID string) (uint, string) {
	runID := strings.TrimSpace(rawRunID)
	if runID != "" {
		if id, err := s.repo.FindAssistantMessageIDByRunID(ctx, userID, runID); err == nil && id > 0 {
			return id, runID
		}
	}
	recent, _, err := s.repo.ListRecentMessages(ctx, conversationID, 12)
	if err != nil {
		return 0, runID
	}
	var anchor *model.Message
	for i := range recent {
		if !strings.EqualFold(strings.TrimSpace(recent[i].Role), "assistant") {
			continue
		}
		if anchor == nil || recent[i].ID > anchor.ID {
			anchor = &recent[i]
		}
	}
	if anchor == nil {
		return 0, runID
	}
	if runID == "" {
		runID = strings.TrimSpace(anchor.RunID)
	}
	return anchor.ID, runID
}

// normalizeProjectPreviewLines 清理并截断回写的 console/错误行，避免超长内容进入会话与证据。
func normalizeProjectPreviewLines(items []string) []string {
	result := make([]string, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(item)
		if text == "" {
			continue
		}
		if runes := []rune(text); len(runes) > projectPreviewResultMaxChars {
			text = string(runes[:projectPreviewResultMaxChars])
		}
		result = append(result, text)
		if len(result) >= projectPreviewResultMaxLines {
			break
		}
	}
	return result
}
