package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/mcp"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

// countingWriter 统计写入字节数并丢弃内容，用于在不保留归档本体的前提下回执大小。
type countingWriter struct{ written int64 }

func (w *countingWriter) Write(p []byte) (int, error) {
	w.written += int64(len(p))
	return len(p), nil
}

// ExecuteToolInput 定义工具执行入参。
type ExecuteToolInput struct {
	UserID          uint
	ConversationID  uint
	RequestID       string
	ProjectPublicID string
	ToolName        string
	ArgumentsJSON   string
	MCPConfig       *mcp.CallConfig
}

func isProjectTool(name string) bool {
	switch strings.TrimSpace(name) {
	case "project_list_files", "project_read_file", "project_search_files", "project_write_file", "project_patch_file", "project_delete_file", "project_create_archive":
		return true
	default:
		return false
	}
}

func (s *Service) executeProjectTool(ctx context.Context, input ExecuteToolInput) (string, error) {
	if strings.TrimSpace(input.ProjectPublicID) == "" {
		return "", fmt.Errorf("project context is required")
	}
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(input.ArgumentsJSON), &args); err != nil {
		return "", err
	}
	project, err := s.repo.GetConversationProjectByPublicID(ctx, input.UserID, input.ProjectPublicID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return "", ErrConversationProjectNotFound
		}
		return "", err
	}
	// 空项目可能尚未创建工作区（未上传文件且从未写入）：
	// 此时视为空文件列表，写入类工具通过 GetOrCreateProjectWorkspace 按需创建工作区。
	files := make([]model.ProjectFile, 0)
	workspace, wsErr := s.repo.GetProjectWorkspaceByProject(ctx, input.UserID, project.ID)
	if wsErr != nil && !errors.Is(wsErr, repository.ErrNotFound) {
		return "", wsErr
	}
	if wsErr == nil {
		if files, err = s.repo.ListProjectFiles(ctx, input.UserID, workspace.ID); err != nil {
			return "", err
		}
	}
	find := func(raw string) (*model.ProjectFile, error) {
		for i := range files {
			if files[i].PublicID == strings.TrimSpace(raw) || files[i].RelativePath == strings.TrimSpace(raw) {
				return &files[i], nil
			}
		}
		return nil, fmt.Errorf("project file not found")
	}
	switch strings.TrimSpace(input.ToolName) {
	case "project_list_files":
		prefix, _ := args["prefix"].(string)
		result := make([]model.ProjectFile, 0, len(files))
		for _, file := range files {
			if prefix == "" || strings.HasPrefix(file.RelativePath, path.Clean(prefix)) {
				result = append(result, file)
			}
		}
		return marshalProjectToolResult(result)
	case "project_read_file":
		file, err := find(stringArg(args, "file"))
		if err != nil {
			return "", err
		}
		content, err := s.OpenProjectFileContent(ctx, input.UserID, input.ProjectPublicID, file.PublicID)
		if err != nil {
			return "", err
		}
		defer content.Reader.Close()
		data, err := io.ReadAll(io.LimitReader(content.Reader, 20<<20))
		if err != nil {
			return "", err
		}
		return marshalProjectToolResult(map[string]interface{}{"file": file, "content": string(data)})
	case "project_search_files":
		query := stringArg(args, "query")
		result := make([]map[string]interface{}, 0)
		for _, file := range files {
			if file.EntryType != model.ProjectFileEntryTypeFile {
				continue
			}
			content, openErr := s.OpenProjectFileContent(ctx, input.UserID, input.ProjectPublicID, file.PublicID)
			if openErr != nil {
				continue
			}
			data, readErr := io.ReadAll(io.LimitReader(content.Reader, 20<<20))
			content.Reader.Close()
			if readErr == nil && strings.Contains(string(data), query) {
				result = append(result, map[string]interface{}{"file": file, "matches": strings.Count(string(data), query)})
			}
		}
		return marshalProjectToolResult(result)
	case "project_write_file":
		file, err := s.WriteProjectFile(ctx, input.UserID, input.ProjectPublicID, stringArg(args, "path"), []byte(stringArg(args, "content")))
		if err != nil {
			return "", err
		}
		return marshalProjectToolResult(file)
	case "project_patch_file":
		file, err := find(stringArg(args, "file"))
		if err != nil {
			return "", err
		}
		content, err := s.OpenProjectFileContent(ctx, input.UserID, input.ProjectPublicID, file.PublicID)
		if err != nil {
			return "", err
		}
		old, err := io.ReadAll(content.Reader)
		content.Reader.Close()
		if err != nil {
			return "", err
		}
		// 补丁列表：兼容旧的单片段 old/new 与新的多片段 patches 数组，按顺序原子应用。
		type patchPair struct{ old, new string }
		patches := make([]patchPair, 0, 4)
		if rawList, ok := args["patches"].([]interface{}); ok && len(rawList) > 0 {
			for _, raw := range rawList {
				item, ok := raw.(map[string]interface{})
				if !ok {
					return "", fmt.Errorf("invalid patches entry")
				}
				patches = append(patches, patchPair{old: stringArg(item, "old"), new: stringArg(item, "new")})
			}
		} else {
			patches = append(patches, patchPair{old: stringArg(args, "old"), new: stringArg(args, "new")})
		}
		updated := string(old)
		for index, patch := range patches {
			if strings.TrimSpace(patch.old) == "" {
				return "", fmt.Errorf("patch %d: empty old snippet", index+1)
			}
			if !strings.Contains(updated, patch.old) {
				preview := patch.old
				if len(preview) > 80 {
					preview = preview[:80] + "..."
				}
				return "", fmt.Errorf("patch %d target not found: %q", index+1, preview)
			}
			updated = strings.Replace(updated, patch.old, patch.new, 1)
		}
		if updated == string(old) {
			return "", fmt.Errorf("patch target not found")
		}
		updatedFile, err := s.WriteProjectFile(ctx, input.UserID, input.ProjectPublicID, file.RelativePath, []byte(updated))
		if err != nil {
			return "", err
		}
		return marshalProjectToolResult(map[string]interface{}{"file": updatedFile, "applied_patches": len(patches)})
	case "project_delete_file":
		file, err := find(stringArg(args, "file"))
		if err != nil {
			return "", err
		}
		deleted, err := s.DeleteProjectFile(ctx, input.UserID, input.ProjectPublicID, file.PublicID)
		if err != nil {
			return "", err
		}
		return marshalProjectToolResult(deleted)
	case "project_create_archive":
		if wsErr != nil {
			return marshalProjectToolResult(map[string]interface{}{"project_id": input.ProjectPublicID, "file_count": 0, "message": "project workspace is empty; nothing to archive yet"})
		}
		// 仅统计归档大小用于回执，避免在内存中保留整个 ZIP；
		// 实际下载由 /conversation-projects/:id/archive 端点按需流式生成。
		counter := &countingWriter{}
		if err := s.ArchiveProjectFiles(ctx, input.UserID, input.ProjectPublicID, counter); err != nil {
			return "", err
		}
		return marshalProjectToolResult(map[string]interface{}{
			"project_id":  input.ProjectPublicID,
			"file_count":  len(files),
			"size_bytes":  counter.written,
			"download_ui": true,
			"message":     "archive ready; the user downloads it from the project panel's ZIP button in the UI. Do not output any download URL or link.",
		})
	default:
		return "", fmt.Errorf("unsupported project tool")
	}
}

func stringArg(args map[string]interface{}, key string) string {
	value, _ := args[key].(string)
	return value
}
func marshalProjectToolResult(value interface{}) (string, error) {
	data, err := json.Marshal(value)
	return string(data), err
}

func (s *Service) executeToolCall(ctx context.Context, input ExecuteToolInput) (string, error) {
	toolName := strings.TrimSpace(input.ToolName)
	if toolName == "" {
		return "", fmt.Errorf("tool name is required")
	}
	if isProjectTool(toolName) {
		return s.executeProjectTool(ctx, input)
	}
	if input.MCPConfig == nil {
		return "", fmt.Errorf("tool %s is not enabled for this run", toolName)
	}
	if s.mcpClient == nil {
		return "", fmt.Errorf("mcp client is not configured")
	}
	cfg := s.cfg.Snapshot()

	limit := cfg.MCPMaxConcurrentCalls
	if limit <= 0 {
		limit = 8
	}

	return s.executeWithToolLimiter(ctx, limit, func() (string, error) {
		return s.callMCPWithRetry(ctx, *input.MCPConfig, mcp.CallInput{
			ToolName:       toolName,
			ArgumentsJSON:  strings.TrimSpace(input.ArgumentsJSON),
			UserID:         input.UserID,
			ConversationID: input.ConversationID,
			RequestID:      strings.TrimSpace(input.RequestID),
		}, cfg.MCPToolRetryCount)
	})
}

func (s *Service) resolveMaxToolCallsPerRun() int {
	maxCalls := s.cfg.Snapshot().MCPMaxToolCallsPerRun
	if maxCalls <= 0 {
		maxCalls = 8
	}
	if maxCalls > 64 {
		maxCalls = 64
	}
	return maxCalls
}

func (s *Service) resolveMaxSelectedToolsPerMessage() int {
	maxTools := s.cfg.Snapshot().MCPMaxSelectedToolsPerMessage
	if maxTools <= 0 {
		maxTools = config.DefaultMCPMaxSelectedToolsPerMessage
	}
	if maxTools > config.MaxMCPSelectedToolsPerMessage {
		maxTools = config.MaxMCPSelectedToolsPerMessage
	}
	return maxTools
}

// ValidateSelectedToolIDs 校验单次消息选择的 MCP 工具数量。
func (s *Service) ValidateSelectedToolIDs(toolIDs []uint) error {
	if len(toolIDs) > s.resolveMaxSelectedToolsPerMessage() {
		return ErrTooManySelectedTools
	}
	return nil
}

func (s *Service) resolveMaxLLMCallsPerRun() int {
	maxCalls := s.cfg.Snapshot().MCPMaxLLMCallsPerRun
	if maxCalls <= 0 {
		maxCalls = 5
	}
	if maxCalls < 2 {
		maxCalls = 2
	}
	if maxCalls > 32 {
		maxCalls = 32
	}
	return maxCalls
}

func (s *Service) executeWithToolLimiter(
	ctx context.Context,
	limit int,
	fn func() (string, error),
) (string, error) {
	if fn == nil {
		return "", fmt.Errorf("tool execution function is nil")
	}
	if limit <= 0 {
		return fn()
	}

	limiter := s.getToolLimiter(limit)
	select {
	case limiter <- struct{}{}:
		defer func() { <-limiter }()
		return fn()
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (s *Service) getToolLimiter(limit int) chan struct{} {
	if limit <= 0 {
		limit = 1
	}
	if value, ok := s.toolLimiters.Load(limit); ok {
		if limiter, castOK := value.(chan struct{}); castOK {
			return limiter
		}
	}
	created := make(chan struct{}, limit)
	actual, _ := s.toolLimiters.LoadOrStore(limit, created)
	limiter, ok := actual.(chan struct{})
	if !ok {
		return created
	}
	return limiter
}

func (s *Service) callMCPWithRetry(
	ctx context.Context,
	cfg mcp.CallConfig,
	input mcp.CallInput,
	retryCount int,
) (string, error) {
	if retryCount < 0 {
		retryCount = 0
	}

	var lastErr error
	for attempt := 0; attempt <= retryCount; attempt++ {
		output, err := s.mcpClient.CallTool(ctx, cfg, input)
		if err == nil {
			return output, nil
		}
		lastErr = err
		if attempt >= retryCount {
			break
		}

		backoff := time.Duration(100*(attempt+1)) * time.Millisecond
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", ctx.Err()
		case <-timer.C:
		}
	}
	return "", lastErr
}
