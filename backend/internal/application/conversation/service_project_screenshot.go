package conversation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	operation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func (s *Service) SetScreenshotRuntime(executor runtime.Executor, repo repository.AgentOperationRepository, cfg config.AgentScreenshotConfig) error {
	s.screenshotRuntime = nil
	if !cfg.Enabled {
		return nil
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if executor == nil || repo == nil || s.repo == nil || s.uploadSvc == nil {
		return fmt.Errorf("离线截图需要运行时、操作仓库、文件仓库和上传服务")
	}
	admission, ok := repo.(repository.AgentCommandAdmissionRepository)
	if !ok {
		return fmt.Errorf("离线截图需要资源准入仓库")
	}
	if _, ok := repo.(repository.AgentCommandSlotRecoveryRepository); !ok {
		return fmt.Errorf("离线截图需要可信容器绑定仓库")
	}
	if _, ok := executor.(interface {
		CheckReadiness(context.Context, string) error
	}); !ok {
		return runtime.ErrUnavailable
	}
	s.screenshotRuntime = &agentCommandRuntime{executor: executor, repo: repo, admission: admission, image: cfg.Image}
	return nil
}

func (s *Service) addScreenshotTool(r *selectedToolRuntime, p AgentPermissions) {
	if !p.ExecuteCode || s.screenshotRuntime == nil || s.storeProvider == nil || s.uploadSvc == nil {
		return
	}
	definition := llm.ToolDefinition{Name: "project_render_screenshot", Description: "将当前可信工作区单个 HTML 的固定快照在断网、非 root sandbox 容器中截为 1280×720 PNG，保存为当前助手消息下载附件。JavaScript、外链、页面交互均不可用；不等于完整页面验证或公网浏览。不得返回 base64 或自行编造下载链接。", InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}`)}
	r.definitions = append(r.definitions, definition)
	r.nameMap[definition.Name] = definition.Name
	r.schemas[definition.Name] = definition.InputSchema
}

func (s *Service) screenshotOwner(ctx context.Context, input ExecuteToolInput) error {
	if input.UserID == 0 || input.ConversationID == 0 || input.MessageID == 0 || input.RunID == "" || input.ToolCallID == "" {
		return ErrInvalidFileReference
	}
	if _, err := s.agentToolWorkspace(ctx, input, false); err != nil {
		return err
	}
	message, err := s.repo.GetMessageByID(ctx, input.ConversationID, input.MessageID)
	if err != nil {
		return err
	}
	if message.UserID != input.UserID || message.Role != "assistant" || message.RunID != input.RunID || message.Status != "pending" {
		return ErrInvalidFileReference
	}
	run, err := s.repo.GetConversationRunByRunID(ctx, input.UserID, input.RunID)
	if err != nil {
		return err
	}
	if run.ConversationID != input.ConversationID {
		return ErrInvalidFileReference
	}
	return nil
}

func (s *Service) screenshotSnapshot(ctx context.Context, input ExecuteToolInput) (uint, []byte, string, error) {
	var args struct {
		Path string `json:"path"`
	}
	if _, err := operation.ParametersHash([]byte(input.ArgumentsJSON)); err != nil {
		return 0, nil, "", runtime.ErrInvalid
	}
	dec := json.NewDecoder(strings.NewReader(input.ArgumentsJSON))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&args); err != nil {
		return 0, nil, "", err
	}
	if dec.Decode(new(any)) != io.EOF {
		return 0, nil, "", runtime.ErrInvalid
	}
	name, err := archiveDeliveryPath(args.Path)
	if err != nil || name != args.Path || strings.ToLower(path.Ext(name)) != ".html" || excludeArchiveDeliveryPath(name) {
		return 0, nil, "", ErrInvalidFileReference
	}
	workspace, err := s.agentToolWorkspace(ctx, input, false)
	if err != nil {
		return 0, nil, "", err
	}
	files, err := s.repo.ListProjectFiles(ctx, input.UserID, workspace.ID)
	if err != nil {
		return 0, nil, "", err
	}
	var selected *model.ProjectFile
	for i := range files {
		if files[i].RelativePath == name {
			if selected != nil {
				return 0, nil, "", ErrInvalidFileReference
			}
			selected = &files[i]
		}
	}
	if selected == nil || selected.EntryType != model.ProjectFileEntryTypeFile {
		return 0, nil, "", ErrInvalidFileReference
	}
	content, err := s.openAgentWorkspaceFile(ctx, selected)
	if err != nil {
		return 0, nil, "", err
	}
	data, readErr := io.ReadAll(io.LimitReader(content.Reader, (1<<20)+1))
	closeErr := content.Reader.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		return 0, nil, "", err
	}
	hash := commandHash(data)
	if len(data) == 0 || len(data) > 1<<20 || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 || hash != selected.SHA256 {
		return 0, nil, "", fmt.Errorf("HTML 快照大小、编码或 hash 无效")
	}
	return workspace.ID, data, hash, nil
}

func parseScreenshotResult(output []byte, hash string) ([]byte, error) {
	if len(output) > 6<<20 {
		return nil, runtime.ErrOutputLimit
	}
	if _, err := operation.ParametersHash(output); err != nil {
		return nil, fmt.Errorf("离线截图结果不是唯一键 JSON")
	}
	var result struct {
		Protocol     int    `json:"protocol"`
		SnapshotHash string `json:"snapshot_hash"`
		MimeType     string `json:"mimeType"`
		Data         string `json:"data"`
	}
	dec := json.NewDecoder(bytes.NewReader(output))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&result); err != nil {
		return nil, err
	}
	if dec.Decode(new(any)) != io.EOF || result.Protocol != 1 || result.SnapshotHash != hash || result.MimeType != "image/png" {
		return nil, fmt.Errorf("离线截图协议或快照 hash 不匹配")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(result.Data)
	if err != nil || len(data) > 4<<20 || len(data) < 8 || !bytes.Equal(data[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return nil, fmt.Errorf("离线截图 PNG 或大小无效")
	}
	size, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || size.Width != 1280 || size.Height != 720 {
		return nil, fmt.Errorf("离线截图尺寸无效")
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		return nil, fmt.Errorf("离线截图 PNG 损坏")
	}
	return data, nil
}

func (s *Service) executeProjectScreenshot(ctx context.Context, input ExecuteToolInput) (output string, err error) {
	if err := ValidateAgentPermissions(input.AgentPermissions); err != nil {
		return "", err
	}
	if !input.AgentPermissions.ExecuteCode {
		return "", runtime.ErrDenied
	}
	r := s.screenshotRuntime
	if r == nil || r.repo == nil || r.executor == nil || s.repo == nil || s.storeProvider == nil || s.uploadSvc == nil {
		return "", runtime.ErrUnavailable
	}
	if err := s.screenshotOwner(ctx, input); err != nil {
		return "", err
	}
	if _, err := s.storeProvider.Open(ctx); err != nil {
		return "", err
	}
	workspaceID, html, hash, err := s.screenshotSnapshot(ctx, input)
	if err != nil {
		return "", err
	}
	parameters, _ := json.Marshal([]any{input.ArgumentsJSON, hash, r.image})
	parameterHash, err := operation.ParametersHash(parameters)
	if err != nil {
		return "", err
	}
	identity, _ := json.Marshal([]any{input.UserID, input.RunID, input.ToolCallID})
	spec := operation.Spec{OwnerUserID: input.UserID, OperationID: "screenshot-" + commandHash(identity), RunID: input.RunID, WorkspaceID: workspaceID, Kind: operation.Command, ParametersHash: parameterHash, ExpectedWorkspaceVersion: hash, PermissionScope: "execute_code:offline_screenshot:" + commandHash([]byte(r.image))}
	item, err := r.repo.Create(ctx, spec)
	if err != nil {
		return "", err
	}
	if item.Status != operation.Pending {
		return "", fmt.Errorf("截图操作已执行，不允许重跑")
	}
	revision := item.Revision
	now := time.Now().UTC()
	if err := r.repo.Approve(ctx, input.UserID, spec.OperationID, revision, operation.Approval{Binding: spec.Binding(), GrantedAt: now, ExpiresAt: now.Add(time.Minute)}); err != nil {
		return "", err
	}
	lease, err := r.admission.AcquireCommandLease(ctx, input.UserID, spec.OperationID)
	if err != nil {
		return "", err
	}
	release := false
	defer func() {
		if release {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err = errors.Join(err, r.admission.ReleaseCommandLease(cleanup, lease))
		}
	}()
	if err := r.repo.Transition(ctx, input.UserID, spec.OperationID, revision+1, operation.Pending, operation.Running, spec.Binding(), ""); err != nil {
		return "", err
	}
	bindings := r.repo.(repository.AgentCommandSlotRecoveryRepository)
	workspace := strconv.FormatUint(uint64(workspaceID), 10)
	result, execErr := r.executor.Execute(ctx, runtime.Request{OperationID: spec.OperationID, TaskID: input.RunID, WorkspaceID: workspace, Permission: runtime.Permission{TaskID: input.RunID, WorkspaceID: workspace, ExecuteCode: true, Network: runtime.NetworkNone, Workspace: runtime.WorkspaceEphemeral}, Image: r.image, Command: []string{"/usr/local/bin/node", "/app/src/offline-cli.js"}, Stdin: html, Limits: runtime.Limits{MilliCPUs: 2000, MemoryBytes: 1 << 30, PIDs: 128, WorkspaceBytes: 256 << 20, InputBytes: 1 << 20, OutputBytes: 6 << 20, Timeout: 60 * time.Second}, BindContainer: func(bindCtx context.Context, id runtime.ContainerIdentity) error {
		return bindings.BindCommandContainer(bindCtx, lease, revision+2, id)
	}})
	if !errors.Is(execErr, runtime.ErrCleanup) {
		release = true
	}
	var pngData []byte
	if execErr == nil {
		if result.ExitCode != 0 {
			execErr = fmt.Errorf("离线 sandbox 截图失败，禁止降级")
		} else {
			pngData, execErr = parseScreenshotResult(result.Output, hash)
		}
	}
	if execErr == nil {
		if ownerErr := s.screenshotOwner(ctx, input); ownerErr != nil {
			execErr = ownerErr
		} else {
			output, execErr = s.deliverScreenshot(ctx, input, pngData, hash)
		}
	}
	status := operation.Succeeded
	if execErr != nil {
		status = operation.Uncertain
	}
	summary, _ := json.Marshal(map[string]any{"snapshot_hash": hash, "offline": true, "cleanup_failed": errors.Is(execErr, runtime.ErrCleanup)})
	finish, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	persistErr := r.repo.Transition(finish, input.UserID, spec.OperationID, revision+2, operation.Running, status, spec.Binding(), string(summary))
	if err := errors.Join(execErr, persistErr); err != nil {
		return "", err
	}
	return output, nil
}

func (s *Service) deliverScreenshot(ctx context.Context, input ExecuteToolInput, data []byte, hash string) (string, error) {
	result, err := s.uploadSvc.UploadFile(ctx, appupload.UploadFileInput{UserID: input.UserID, Purpose: "generated_image", FileName: "offline-screenshot.png", MimeType: "image/png", DeclaredSize: int64(len(data)), Reader: bytes.NewReader(data)})
	if err != nil {
		return "", err
	}
	if err := s.screenshotOwner(ctx, input); err != nil {
		return "", err
	}
	file := result.File
	if err := s.repo.CreateAttachments(ctx, []model.Attachment{{ConversationID: input.ConversationID, MessageID: input.MessageID, UserID: input.UserID, FileID: file.FileID, Kind: "image", FileName: file.FileName, MimeType: file.MimeType, FileSize: file.SizeBytes, SHA256: file.SHA256, StoragePath: file.StoragePath, Status: "active", UploadedAt: time.Now()}}); err != nil {
		return "", err
	}
	return marshalProjectToolResult(map[string]any{"file_id": file.FileID, "file_name": file.FileName, "size_bytes": file.SizeBytes, "snapshot_hash": hash, "download_ui": true, "offline": true, "javascript": false, "public_network": false, "message": "离线静态截图已保存为当前助手消息附件，请从附件下载；不是完整页面交互验证，不要输出 base64、URL 或链接。"})
}
