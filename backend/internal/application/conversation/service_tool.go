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

	"github.com/google/uuid"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/mcpauth"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/mcp"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

// ExecuteToolInput 定义工具执行入参。
type ExecuteToolInput struct {
	browserSnapshot  *projectBrowserSnapshot
	ToolCallID       string
	AgentPermissions AgentPermissions
	WorkspaceID      uint
	UserID           uint
	ConversationID   uint
	MessageID        uint
	RunID            string
	RequestID        string
	ProjectPublicID  string
	ToolName         string
	ArgumentsJSON    string
	MCPConfig        *mcp.CallConfig
}

func isProjectTool(name string) bool {
	switch strings.TrimSpace(name) {
	case "project_browser_run", "project_render_screenshot", "project_list_files", "project_read_file", "project_search_files", "project_write_file", "project_patch_file", "project_delete_file", "project_create_archive", "project_show_diff", "project_preview":
		return true
	default:
		return false
	}
}

func (s *Service) executeProjectTool(ctx context.Context, input ExecuteToolInput) (string, error) {
	if err := authorizeAgentFileTool(input.ToolName, input.AgentPermissions); err != nil {
		return "", err
	}
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(input.ArgumentsJSON), &args); err != nil {
		return "", err
	}
	files := make([]model.ProjectFile, 0)
	workspace, wsErr := s.agentToolWorkspace(ctx, input, false)
	if wsErr != nil && !errors.Is(wsErr, repository.ErrNotFound) {
		return "", wsErr
	}
	var err error
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
		content, err := s.openAgentWorkspaceFile(ctx, file)
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
			content, openErr := s.openAgentWorkspaceFile(ctx, &file)
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
		relative, err := normalizeProjectFilePath(stringArg(args, "path"))
		if err != nil {
			return "", err
		}
		before := ""
		version := 0
		expectedID := ""
		for i := range files {
			if files[i].RelativePath != relative {
				continue
			}
			version, expectedID = files[i].Version, files[i].PublicID
			store, openErr := s.storeProvider.Open(ctx)
			if openErr != nil {
				return "", openErr
			}
			reader, _, openErr := store.Open(ctx, files[i].StorageKey)
			if openErr != nil {
				return "", openErr
			}
			data, readErr := io.ReadAll(io.LimitReader(reader, maxProjectArchiveFileBytes+1))
			reader.Close()
			if readErr != nil {
				return "", readErr
			}
			if len(data) > maxProjectArchiveFileBytes {
				return "", ErrFileTooLarge
			}
			before = string(data)
			break
		}
		after := stringArg(args, "content")
		file, err := s.writeAgentWorkspaceFile(ctx, input, relative, []byte(after), &version, expectedID)
		if err != nil {
			return "", err
		}
		return marshalProjectToolResult(map[string]interface{}{"file": file, "file_diff": newProjectToolDiff(relative, before, after, version == 0)})
	case "project_patch_file":
		file, err := find(stringArg(args, "file"))
		if err != nil {
			return "", err
		}
		store, err := s.storeProvider.Open(ctx)
		if err != nil {
			return "", err
		}
		// 从同一版本快照的不可变对象读取，避免二次查库得到不同版本的内容。
		reader, _, err := store.Open(ctx, file.StorageKey)
		if err != nil {
			return "", err
		}
		old, err := io.ReadAll(io.LimitReader(reader, maxProjectArchiveFileBytes+1))
		reader.Close()
		if err != nil {
			return "", err
		}
		if len(old) > maxProjectArchiveFileBytes {
			return "", ErrFileTooLarge
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
			if first := strings.Index(updated, patch.old); first >= 0 && strings.Contains(updated[first+1:], patch.old) {
				return "", fmt.Errorf("patch %d: ambiguous old snippet; provide a unique match", index+1)
			}
			updated = strings.Replace(updated, patch.old, patch.new, 1)
		}
		if updated == string(old) {
			return "", fmt.Errorf("patch target not found")
		}
		updatedFile, err := s.writeAgentWorkspaceFile(ctx, input, file.RelativePath, []byte(updated), &file.Version, file.PublicID)
		if err != nil {
			return "", err
		}
		return marshalProjectToolResult(map[string]interface{}{"file": updatedFile, "applied_patches": len(patches), "file_diff": newProjectToolDiff(file.RelativePath, string(old), updated, false)})
	case "project_delete_file":
		return "", ErrAgentDeleteDenied
	case "project_create_archive":
		return s.createProjectArchiveDelivery(ctx, input)
	case "project_show_diff":
		// 纯展示工具：不改动文件，直接回传结构化内容供前端渲染 diff 卡片。
		return marshalProjectToolResult(map[string]interface{}{
			"path":   stringArg(args, "path"),
			"before": stringArg(args, "before"),
			"after":  stringArg(args, "after"),
			"title":  stringArg(args, "title"),
		})
	case "project_preview":
		// 预览工具：只校验入口文件存在并回传结构化信息，实际运行与报错捕获在前端沙箱完成。
		entryPath, previewErr := resolveProjectPreviewEntry(files, stringArg(args, "path"))
		if previewErr != nil {
			return "", previewErr
		}
		return marshalProjectToolResult(map[string]interface{}{
			"path":        entryPath,
			"entry_path":  entryPath,
			"file_count":  len(files),
			"project_id":  input.ProjectPublicID,
			"previewable": true,
			"message":     "preview ready; the client renders it in a sandboxed iframe and reports console output and errors back",
		})
	default:
		return "", fmt.Errorf("unsupported project tool")
	}
}

type projectToolDiff struct {
	Path      string `json:"path"`
	Before    string `json:"before"`
	After     string `json:"after"`
	Created   bool   `json:"created"`
	Truncated bool   `json:"truncated"`
}

func newProjectToolDiff(path, before, after string, created bool) *projectToolDiff {
	diff := &projectToolDiff{Path: path, Created: created}
	// 完整保留小型文本快照；超限不提供部分文本，避免部分差异被误认为完整差异。
	if len(before)+len(after) > 32*1024 || strings.Count(before, "\n") > 1000 || strings.Count(after, "\n") > 1000 {
		diff.Truncated = true
		return diff
	}
	diff.Before, diff.After = before, after
	return diff
}

func stringArg(args map[string]interface{}, key string) string {
	value, _ := args[key].(string)
	return value
}

func marshalProjectToolResult(value interface{}) (string, error) {
	data, err := json.Marshal(value)
	return string(data), err
}

// projectPreviewEntryCandidates 是未显式指定入口时按序回退的常见入口文件。
var projectPreviewEntryCandidates = []string{"index.html", "index.htm", "public/index.html", "src/index.html"}

// isPreviewableProjectEntry 判断入口是否为可在沙箱 iframe 中渲染的 HTML/SVG 文件。
func isPreviewableProjectEntry(filePath string) bool {
	extension := strings.ToLower(strings.TrimPrefix(path.Ext(filePath), "."))
	switch extension {
	case "html", "htm", "svg":
		return true
	default:
		return false
	}
}

// resolveProjectPreviewEntry 解析预览入口：显式路径需存在且可预览；缺省时回退到常见入口，均不存在则报错。
func resolveProjectPreviewEntry(files []model.ProjectFile, raw string) (string, error) {
	normalize := func(value string) string {
		return strings.Trim(path.Clean(strings.ReplaceAll(value, "\\", "/")), "/")
	}
	exists := func(candidate string) bool {
		for i := range files {
			if files[i].EntryType != model.ProjectFileEntryTypeFile {
				continue
			}
			if strings.EqualFold(files[i].RelativePath, candidate) {
				return true
			}
		}
		return false
	}
	if requested := strings.TrimSpace(raw); requested != "" {
		normalized := normalize(requested)
		if normalized == "" || normalized == "." {
			return "", fmt.Errorf("project preview: invalid entry path")
		}
		if !exists(normalized) {
			return "", fmt.Errorf("project preview: entry file not found: %s", normalized)
		}
		if !isPreviewableProjectEntry(normalized) {
			return "", fmt.Errorf("project preview: %s is not a previewable HTML/SVG file", normalized)
		}
		return normalized, nil
	}
	for _, candidate := range projectPreviewEntryCandidates {
		if exists(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("project preview: no previewable entry found; provide an explicit path such as index.html")
}

func (s *Service) executeToolCall(ctx context.Context, input ExecuteToolInput) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if input.ConversationID != 0 {
		conversation, err := s.repo.GetConversationByUser(ctx, input.ConversationID, input.UserID)
		if err != nil {
			return "", err
		}
		if conversation.Status == "deleting" {
			return "", ErrDeletionPending
		}
		if conversation.ProjectPublicID != strings.TrimSpace(input.ProjectPublicID) {
			return "", ErrInvalidFileReference
		}
	}
	toolName := strings.TrimSpace(input.ToolName)
	if toolName == "" {
		return "", fmt.Errorf("tool name is required")
	}
	if toolName == "project_browser_run" {
		return s.executeProjectBrowser(ctx, input)
	}
	if toolName == "project_render_screenshot" {
		return s.executeProjectScreenshot(ctx, input)
	}
	if toolName == "workspace_run_command" {
		return s.executeWorkspaceCommand(ctx, input)
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
	mcpCfg, err := applySignedUserContext(cfg, *input.MCPConfig, input)
	if err != nil {
		return "", err
	}

	limit := cfg.MCPMaxConcurrentCalls
	if limit <= 0 {
		limit = 8
	}

	return s.executeWithToolLimiter(ctx, limit, func() (string, error) {
		return s.callMCPWithRetry(ctx, mcpCfg, mcp.CallInput{
			ToolName:       toolName,
			ArgumentsJSON:  strings.TrimSpace(input.ArgumentsJSON),
			UserID:         input.UserID,
			ConversationID: input.ConversationID,
			RequestID:      strings.TrimSpace(input.RequestID),
		}, cfg.MCPToolRetryCount)
	})
}

// applySignedUserContext 将请求头中值等于 ${DEEIX_SIGNED_USER_CONTEXT} 占位符的项
// 替换为本次工具调用签名的用户上下文。未配置占位符时原样返回，不改变现有行为；
// 签名失败时拒绝调用，避免 MCP 服务端收到没有用户上下文的请求。
//
// token 在一次工具调用中只签发一次，callMCPWithRetry 的各次重试携带同一个 jti：
// 首次请求可能已被服务端执行而只是响应丢失，重试沿用 jti 才能让服务端去重。
func applySignedUserContext(cfg config.Config, base mcp.CallConfig, input ExecuteToolInput) (mcp.CallConfig, error) {
	if len(base.Headers) == 0 {
		return base, nil
	}
	matched := false
	for _, value := range base.Headers {
		if strings.TrimSpace(value) == mcpauth.TemplateSignedUserContext {
			matched = true
			break
		}
	}
	if !matched {
		return base, nil
	}
	token, err := mcpauth.Sign(cfg.MCPUserContextSecret, mcpauth.Payload{
		UserID:         input.UserID,
		ConversationID: input.ConversationID,
		RequestID:      strings.TrimSpace(input.RequestID),
		Audience:       base.BaseURL,
		JTI:            uuid.NewString(),
		ExpiresAt:      time.Now().Add(mcpauth.DefaultTTL).Unix(),
	})
	if err != nil || token == "" {
		return mcp.CallConfig{}, fmt.Errorf("mcp user context signing failed")
	}
	expanded := make(map[string]string, len(base.Headers))
	for key, value := range base.Headers {
		if strings.TrimSpace(value) != mcpauth.TemplateSignedUserContext {
			expanded[key] = value
			continue
		}
		expanded[key] = token
	}
	base.Headers = expanded
	return base, nil
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
