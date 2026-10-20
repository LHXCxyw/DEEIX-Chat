package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type agentWorkspaceRepo struct {
	*projectVersionTestRepo
	creates int
	absent  bool
}

func (r *agentWorkspaceRepo) GetConversationByUser(_ context.Context, id, user uint) (*model.Conversation, error) {
	if id != 7 || user != 1 {
		return nil, repository.ErrNotFound
	}
	return &model.Conversation{ID: 7, UserID: 1}, nil
}
func (r *agentWorkspaceRepo) GetConversationWorkspace(_ context.Context, user, conversation uint) (*model.ProjectWorkspace, error) {
	if r.absent {
		return nil, repository.ErrNotFound
	}
	return &model.ProjectWorkspace{ID: 2, OwnerUserID: user, ConversationID: &conversation}, nil
}
func (r *agentWorkspaceRepo) GetOrCreateConversationWorkspace(ctx context.Context, user, conversation uint, _ string) (*model.ProjectWorkspace, error) {
	r.creates++
	r.absent = false
	return r.GetConversationWorkspace(ctx, user, conversation)
}
func TestAgentPermissionValidationAndDispatch(t *testing.T) {
	for _, p := range []AgentPermissions{{BrowseProject: true}, {BrowsePublic: true}, {ExtractArchives: true}} {
		if !errors.Is(ValidateAgentPermissions(p), ErrAgentPermissionUnsupported) {
			t.Fatal("不支持的权限未拒绝")
		}
	}
	service := &Service{}
	for _, tool := range []string{"project_write_file", "project_patch_file", "project_create_archive", "project_delete_file"} {
		_, err := service.executeToolCall(context.Background(), ExecuteToolInput{ToolName: tool, ArgumentsJSON: `{}`})
		if err == nil {
			t.Fatalf("未授权工具被执行: %s", tool)
		}
	}
	result := service.executeAssistantToolCalls(context.Background(), executeAssistantToolCallsInput{Ephemeral: true, ToolCalls: []llm.ToolCall{{ToolName: "project_write_file", ArgumentsJSON: `{}`}}})
	if len(result.Rows) != 1 || result.Rows[0].Status != "error" {
		t.Fatal("伪造调用未拒绝")
	}
}
func TestAgentOrdinaryConversationWorkspace(t *testing.T) {
	service, base := newProjectVersionTestService(t, "hello")
	repo := &agentWorkspaceRepo{projectVersionTestRepo: base, absent: true}
	service.repo = repo
	runtime := selectedToolRuntime{nameMap: map[string]string{}, schemas: map[string]json.RawMessage{}}
	addProjectToolDefinitions(&runtime)
	_, _, err := service.prepareAgentFileRuntime(context.Background(), SendMessageInput{UserID: 1, ConversationID: 7}, runtime)
	if err != nil || repo.creates != 0 {
		t.Fatalf("普通聊天创建了工作区: %v", err)
	}
	input := ExecuteToolInput{UserID: 1, ConversationID: 7, AgentPermissions: AgentPermissions{EditFiles: true}, ToolName: "project_patch_file", ArgumentsJSON: `{"file":"a.txt","old":"hello","new":"world"}`}
	repo.absent = false
	if _, err = service.executeToolCall(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if base.cas != 1 || base.changes != 1 {
		t.Fatal("普通会话未使用CAS及变更日志")
	}
	input.AgentPermissions = AgentPermissions{}
	input.ToolName = "project_read_file"
	input.ArgumentsJSON = `{"file":"a.txt"}`
	output, err := service.executeToolCall(context.Background(), input)
	if err != nil || !strings.Contains(output, "world") {
		t.Fatalf("read=%s err=%v", output, err)
	}
	input.ToolName = "project_write_file"
	if _, err = service.executeToolCall(context.Background(), input); !errors.Is(err, ErrAgentEditRequired) {
		t.Fatal("权限跨请求泄漏")
	}
	input.AgentPermissions.EditFiles = true
	input.ArgumentsJSON = `{"path":"../escape","content":"bad"}`
	if _, err = service.executeToolCall(context.Background(), input); !errors.Is(err, ErrInvalidFileReference) {
		t.Fatal("路径逃逸未拒绝")
	}
	input.ToolName = "project_list_files"
	input.ArgumentsJSON = `{}`
	input.WorkspaceID = 99
	if _, err = service.executeToolCall(context.Background(), input); !errors.Is(err, ErrInvalidFileReference) {
		t.Fatal("工作区上下文不匹配未拒绝")
	}
}
