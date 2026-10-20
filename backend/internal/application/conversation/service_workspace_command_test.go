package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
	operation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type commandOperationRepo struct {
	repository.AgentOperationRepository
	item        *operation.Operation
	failRunning bool
	lease       admission.Lease
}

func (r *commandOperationRepo) ListOccupiedCommandSlots(context.Context) ([]admission.CommandSlotSnapshot, error) {
	return nil, nil
}
func (r *commandOperationRepo) ReleaseRecoveredCommandSlot(context.Context, admission.CommandSlotSnapshot) error {
	return nil
}
func (r *commandOperationRepo) BindCommandContainer(_ context.Context, lease admission.Lease, revision uint64, id runtime.ContainerIdentity) error {
	if lease != r.lease || revision != r.item.Revision || id.TaskID != r.item.RunID || id.OperationID != r.item.OperationID {
		return repository.ErrConflict
	}
	return nil
}

func (r *commandOperationRepo) AcquireCommandLease(_ context.Context, owner uint, id string) (admission.Lease, error) {
	if r.lease.Token != "" {
		return admission.Lease{}, admission.ErrBusy
	}
	r.lease = admission.Lease{Slot: 0, OwnerUserID: owner, OperationID: id, Token: "test-token"}
	return r.lease, nil
}
func (r *commandOperationRepo) ReleaseCommandLease(_ context.Context, lease admission.Lease) error {
	if lease.Token != r.lease.Token {
		return repository.ErrConflict
	}
	r.lease = admission.Lease{}
	return nil
}

func (r *commandOperationRepo) Create(_ context.Context, s operation.Spec) (*operation.Operation, error) {
	if r.item != nil {
		if r.item.Spec != s {
			return nil, repository.ErrConflict
		}
		return r.item, nil
	}
	r.item = &operation.Operation{Spec: s, Status: operation.Pending, Revision: 1}
	return r.item, nil
}
func (r *commandOperationRepo) Approve(_ context.Context, _ uint, _ string, revision uint64, a operation.Approval) error {
	if revision != r.item.Revision {
		return repository.ErrConflict
	}
	r.item.Approval = &a
	r.item.Revision++
	return nil
}
func (r *commandOperationRepo) Transition(_ context.Context, _ uint, _ string, revision uint64, from, to operation.Status, b operation.Binding, _ string) error {
	if to == operation.Running && r.failRunning {
		return repository.ErrConflict
	}
	if revision != r.item.Revision || from != r.item.Status || b != r.item.Binding() {
		return repository.ErrConflict
	}
	r.item.Status = to
	r.item.Revision++
	return nil
}

type commandExecutor struct {
	calls int
	repo  *commandOperationRepo
	err   error
	panic bool
}

func (e *commandExecutor) Execute(_ context.Context, r runtime.Request) (runtime.Result, error) {
	e.calls++
	if e.panic {
		panic("模拟执行器崩溃")
	}
	if e.repo.item.Status != operation.Running {
		panic("执行前未持久化")
	}
	if r.BindContainer == nil {
		panic("执行前未提供身份绑定")
	}
	if err := r.BindContainer(context.Background(), runtime.ContainerIdentity{ID: strings.Repeat("b", 64), Owner: strings.Repeat("a", 64), TaskID: r.TaskID, OperationID: r.OperationID}); err != nil {
		return runtime.Result{}, err
	}
	var input struct {
		SnapshotHash string                `json:"snapshot_hash"`
		Files        []commandSnapshotFile `json:"files"`
	}
	if err := json.Unmarshal(r.Stdin, &input); err != nil {
		panic(err)
	}
	output, _ := json.Marshal(commandRunnerResult{Protocol: 1, ExitCode: 7, Stdout: "真实输出", Stderr: "错误输出", SnapshotHash: input.SnapshotHash})
	return runtime.Result{ExitCode: 0, Output: output}, e.err
}
func TestWorkspaceCommandAuthorizationPersistenceAndReplay(t *testing.T) {
	for _, scenario := range []string{"success", "uncertain", "persist failure", "no permission", "disabled", "hash mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			service, files := newProjectVersionTestService(t, "hello")
			files.file.SHA256 = commandHash([]byte("hello"))
			repo := &commandOperationRepo{}
			executor := &commandExecutor{repo: repo}
			image := "local/runner@sha256:" + strings.Repeat("a", 64)
			if err := service.SetAgentRuntime(executor, repo, config.AgentCommandConfig{Enabled: true, Image: image, AllowedImages: []string{image}}); err != nil {
				t.Fatal(err)
			}
			input := ExecuteToolInput{UserID: 1, ConversationID: 3, RunID: "run", ToolCallID: "call", ProjectPublicID: "project", AgentPermissions: AgentPermissions{ExecuteCode: true}, ToolName: "workspace_run_command", ArgumentsJSON: `{"argv":["python3","a.txt"]}`}
			switch scenario {
			case "uncertain":
				executor.err = errors.New("连接丢失")
			case "persist failure":
				repo.failRunning = true
			case "no permission":
				input.AgentPermissions.ExecuteCode = false
			case "disabled":
				service.agentRuntime = nil
			case "hash mismatch":
				files.file.SHA256 = "bad"
			}
			result, err := service.executeToolCall(context.Background(), input)
			if scenario == "success" {
				if err != nil || !strings.Contains(result, `"exit_code":7`) || !strings.Contains(result, `"persistent_changes":false`) {
					t.Fatalf("result=%s err=%v", result, err)
				}
				if repo.item.Status != operation.Failed {
					t.Fatal(repo.item.Status)
				}
			} else if err == nil {
				t.Fatal("应拒绝或报告失败")
			}
			if scenario == "success" || scenario == "uncertain" {
				if scenario == "uncertain" && repo.item.Status != operation.Uncertain {
					t.Fatal(repo.item.Status)
				}
				if _, err := service.executeToolCall(context.Background(), input); err == nil {
					t.Fatal("不允许重跑")
				}
				if executor.calls != 1 {
					t.Fatal(executor.calls)
				}
			} else if executor.calls != 0 {
				t.Fatal("不安全执行")
			}
		})
	}
}
func TestWorkspaceCommandKeepsLeaseWhenExecutorPanics(t *testing.T) {
	service, files := newProjectVersionTestService(t, "hello")
	files.file.SHA256 = commandHash([]byte("hello"))
	repo := &commandOperationRepo{}
	executor := &commandExecutor{repo: repo, panic: true}
	image := "local/runner@sha256:" + strings.Repeat("a", 64)
	if err := service.SetAgentRuntime(executor, repo, config.AgentCommandConfig{Enabled: true, Image: image, AllowedImages: []string{image}}); err != nil {
		t.Fatal(err)
	}
	input := ExecuteToolInput{UserID: 1, ConversationID: 3, RunID: "run", ToolCallID: "panic", ProjectPublicID: "project", AgentPermissions: AgentPermissions{ExecuteCode: true}, ToolName: "workspace_run_command", ArgumentsJSON: `{"argv":["python3","a.txt"]}`}
	defer func() {
		if recover() == nil {
			t.Fatal("执行器崩溃应被测试捕获")
		}
		if repo.lease.Token == "" {
			t.Fatal("执行器崩溃时不得释放租约")
		}
	}()
	_, _ = service.executeToolCall(context.Background(), input)
}

func TestWorkspaceCommandTextPaths(t *testing.T) {
	for _, name := range []string{".env", "secrets/a.py", ".git/config", "node_modules/a.js", "private.key", "image.png"} {
		if commandTextPath(name) {
			t.Fatal(name)
		}
	}
	if !commandTextPath("src/main.py") {
		t.Fatal("文本源码应允许")
	}
	if err := ValidateAgentPermissions(AgentPermissions{ExecuteCode: true}); err != nil {
		t.Fatal(err)
	}
}
