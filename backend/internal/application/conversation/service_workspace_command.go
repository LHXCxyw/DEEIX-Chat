package conversation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	operation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type agentCommandRuntime struct {
	executor  runtime.Executor
	repo      repository.AgentOperationRepository
	admission repository.AgentCommandAdmissionRepository
	image     string
}

// SetAgentRuntime 只能在应用启动时注入。缺少任一安全依赖均拒绝启用。
func (s *Service) SetAgentRuntime(executor runtime.Executor, repo repository.AgentOperationRepository, cfg config.AgentCommandConfig) error {
	s.agentRuntime = nil
	if !cfg.Enabled {
		return nil
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if executor == nil || repo == nil {
		return fmt.Errorf("命令执行需要隔离运行时及操作持久化仓库")
	}
	admissionRepo, ok := repo.(repository.AgentCommandAdmissionRepository)
	if !ok {
		return fmt.Errorf("命令执行需要数据库资源准入仓库")
	}
	if _, ok := repo.(repository.AgentCommandSlotRecoveryRepository); !ok {
		return fmt.Errorf("命令执行需要可信容器身份持久化仓库")
	}
	s.agentRuntime = &agentCommandRuntime{executor: executor, repo: repo, admission: admissionRepo, image: cfg.Image}
	return nil
}

func (s *Service) addAgentCommandTool(r *selectedToolRuntime, p AgentPermissions) {
	if !p.ExecuteCode || s.agentRuntime == nil {
		return
	}
	definition := llm.ToolDefinition{Name: "workspace_run_command", Description: "在断网、限额的一次性容器中执行 argv，验证当前工作区允许文本文件的哈希快照。仅返回真实退出码及输出，容器修改不会回写；不支持安装依赖、联网、秘密、宿主路径或持久修改。", InputSchema: json.RawMessage(`{"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1}},"required":["argv"],"additionalProperties":false}`)}
	r.definitions = append(r.definitions, definition)
	r.nameMap[definition.Name] = definition.Name
	r.schemas[definition.Name] = definition.InputSchema
}

type commandSnapshotFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	SHA256  string `json:"sha256"`
}
type commandRunnerResult struct {
	Protocol          int    `json:"protocol"`
	ExitCode          int    `json:"exit_code"`
	Stdout            string `json:"stdout"`
	Stderr            string `json:"stderr"`
	Timeout           bool   `json:"timeout"`
	OutputLimit       bool   `json:"output_limit"`
	SnapshotHash      string `json:"snapshot_hash"`
	PersistentChanges bool   `json:"persistent_changes"`
}

func commandHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func commandTextPath(name string) bool {
	if excludeArchiveDeliveryPath(name) {
		return false
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".txt", ".md", ".go", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".toml", ".html", ".css", ".svg", ".sh", ".sql", ".rs", ".mod", ".sum", ".lock":
		return true
	}
	return name == "Dockerfile" || name == "Makefile"
}

func (s *Service) commandSnapshot(ctx context.Context, input ExecuteToolInput) (uint, []commandSnapshotFile, string, error) {
	workspace, err := s.agentToolWorkspace(ctx, input, false)
	if err != nil {
		return 0, nil, "", err
	}
	files, err := s.repo.ListProjectFiles(ctx, input.UserID, workspace.ID)
	if err != nil {
		return 0, nil, "", err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].RelativePath < files[j].RelativePath })
	snapshot := make([]commandSnapshotFile, 0)
	seen := map[string]bool{}
	total := 0
	for _, file := range files {
		if file.EntryType != model.ProjectFileEntryTypeFile {
			continue
		}
		name, err := archiveDeliveryPath(file.RelativePath)
		if err != nil {
			return 0, nil, "", err
		}
		if !commandTextPath(name) {
			continue
		}
		if seen[name] || len(snapshot) >= 256 {
			return 0, nil, "", fmt.Errorf("命令快照文件数或路径无效")
		}
		seen[name] = true
		content, err := s.openAgentWorkspaceFile(ctx, &file)
		if err != nil {
			return 0, nil, "", err
		}
		data, readErr := io.ReadAll(io.LimitReader(content.Reader, (1<<20)+1))
		closeErr := content.Reader.Close()
		if err := errors.Join(readErr, closeErr); err != nil {
			return 0, nil, "", err
		}
		total += len(data)
		if len(data) > 1<<20 || total > 2<<20 {
			return 0, nil, "", fmt.Errorf("命令快照大小超过限制")
		}
		hash := commandHash(data)
		if hash != file.SHA256 {
			return 0, nil, "", fmt.Errorf("命令快照文件 hash 不匹配")
		}
		if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			continue
		}
		snapshot = append(snapshot, commandSnapshotFile{Path: name, Content: string(data), SHA256: hash})
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return 0, nil, "", err
	}
	return workspace.ID, snapshot, commandHash(raw), nil
}

func (s *Service) executeWorkspaceCommand(ctx context.Context, input ExecuteToolInput) (output string, err error) {
	if err := ValidateAgentPermissions(input.AgentPermissions); err != nil {
		return "", err
	}
	if !input.AgentPermissions.ExecuteCode {
		return "", runtime.ErrDenied
	}
	r := s.agentRuntime
	if r == nil || r.repo == nil || r.executor == nil {
		return "", fmt.Errorf("命令执行已禁用或管理员隔离配置不可用")
	}
	if input.RunID == "" || input.ToolCallID == "" {
		return "", fmt.Errorf("命令执行需要稳定 run/toolcall 标识")
	}
	var args struct {
		Argv []string `json:"argv"`
	}
	dec := json.NewDecoder(strings.NewReader(input.ArgumentsJSON))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&args); err != nil {
		return "", err
	}
	if len(args.Argv) == 0 || len(args.Argv) > 64 {
		return "", runtime.ErrInvalid
	}
	size := 0
	for _, arg := range args.Argv {
		size += len(arg)
		if strings.ContainsRune(arg, 0) {
			return "", runtime.ErrInvalid
		}
	}
	if args.Argv[0] == "" || size > 16<<10 {
		return "", runtime.ErrInvalid
	}
	workspaceID, files, snapshotHash, err := s.commandSnapshot(ctx, input)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(map[string]any{"protocol": 1, "argv": args.Argv, "files": files, "snapshot_hash": snapshotHash, "timeout_seconds": 30})
	if err != nil {
		return "", err
	}
	if len(payload) > 8<<20 {
		return "", fmt.Errorf("命令快照编码大小超过限制")
	}
	parameters, err := operation.ParametersHash(payload)
	if err != nil {
		return "", err
	}
	idBytes, _ := json.Marshal([]any{input.UserID, input.RunID, input.ToolCallID})
	spec := operation.Spec{OwnerUserID: input.UserID, OperationID: "command-" + commandHash(idBytes), RunID: input.RunID, WorkspaceID: workspaceID, Kind: operation.Command, ParametersHash: parameters, ExpectedWorkspaceVersion: snapshotHash, PermissionScope: "execute_code:ephemeral:" + commandHash([]byte(r.image))}
	item, err := r.repo.Create(ctx, spec)
	if err != nil {
		return "", err
	}
	if item.Status != operation.Pending {
		return "", fmt.Errorf("操作 %s 状态为 %s，不会重新执行", spec.OperationID, item.Status)
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
	// 执行器可能在容器状态未知时崩溃；在拿到返回值前必须保持租约，fail closed。
	releaseLease := false
	defer func() {
		if releaseLease {
			err = errors.Join(err, r.admission.ReleaseCommandLease(context.Background(), lease))
		}
	}()
	if err := r.repo.Transition(ctx, input.UserID, spec.OperationID, revision+1, operation.Pending, operation.Running, spec.Binding(), ""); err != nil {
		return "", err
	}
	bindings, ok := r.repo.(repository.AgentCommandSlotRecoveryRepository)
	if !ok {
		return "", runtime.ErrUnavailable
	}
	if _, err := s.agentToolWorkspace(ctx, input, false); err != nil {
		releaseLease = true
		return "", err
	}
	result, execErr := r.executor.Execute(ctx, runtime.Request{BindContainer: func(bindCtx context.Context, id runtime.ContainerIdentity) error {
		return bindings.BindCommandContainer(bindCtx, lease, revision+2, id)
	}, OperationID: spec.OperationID, TaskID: input.RunID, WorkspaceID: strconv.FormatUint(uint64(workspaceID), 10), Permission: runtime.Permission{TaskID: input.RunID, WorkspaceID: strconv.FormatUint(uint64(workspaceID), 10), ExecuteCode: true, Network: runtime.NetworkNone, Workspace: runtime.WorkspaceEphemeral}, Image: r.image, Command: []string{"/usr/local/bin/python3", "-I", "/opt/deeix/runner.py"}, Stdin: payload, Limits: runtime.Limits{MilliCPUs: 1000, MemoryBytes: 256 << 20, PIDs: 64, WorkspaceBytes: 64 << 20, InputBytes: 8 << 20, OutputBytes: 1 << 20, Timeout: 40 * time.Second}})
	if !errors.Is(execErr, runtime.ErrCleanup) {
		releaseLease = true
	}
	parsed := commandRunnerResult{ExitCode: -1}
	if execErr == nil && (result.ExitCode != 0 || json.Unmarshal(result.Output, &parsed) != nil || parsed.Protocol != 1 || parsed.SnapshotHash != snapshotHash || parsed.PersistentChanges) {
		execErr = fmt.Errorf("隔离 runner 返回无效或不匹配结果")
	}
	status := operation.Succeeded
	if execErr != nil {
		status = operation.Uncertain
	} else if parsed.ExitCode != 0 || parsed.Timeout || parsed.OutputLimit {
		status = operation.Failed
	}
	summary, _ := json.Marshal(map[string]any{"exit_code": parsed.ExitCode, "timeout": parsed.Timeout, "snapshot_hash": snapshotHash, "persistent_changes": false, "cleanup_failed": errors.Is(execErr, runtime.ErrCleanup)})
	finishCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	persistErr := r.repo.Transition(finishCtx, input.UserID, spec.OperationID, revision+2, operation.Running, status, spec.Binding(), string(summary))
	if err := errors.Join(execErr, persistErr); err != nil {
		return "", err
	}
	return marshalProjectToolResult(map[string]any{"operation_id": spec.OperationID, "exit_code": parsed.ExitCode, "stdout": parsed.Stdout, "stderr": parsed.Stderr, "timeout": parsed.Timeout, "output_limit": parsed.OutputLimit, "snapshot_hash": snapshotHash, "persistent_changes": false})
}
