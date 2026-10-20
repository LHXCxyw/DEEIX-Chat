package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	domainsetting "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/settings"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"testing"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type approvalSettingsStub struct{ repository.SettingsRepository }

func (*approvalSettingsStub) ListByNamespace(context.Context, string) ([]domainsetting.SystemSetting, error) {
	return []domainsetting.SystemSetting{{Key: "approval_model", Value: "safety-platform"}}, nil
}

type approvalRouteStub struct{ routeResolver }

func (*approvalRouteStub) ResolveRoute(_ context.Context, input channel.ResolveRouteInput) (*channel.ResolvedRoute, error) {
	if input.PlatformModelName != "safety-platform" {
		return nil, fmt.Errorf("意外模型")
	}
	return &channel.ResolvedRoute{}, nil
}

type approvalGatewayStub struct {
	llmGateway
	response string
	err      error
}

func (g *approvalGatewayStub) Generate(_ context.Context, _ llm.RouteConfig, input llm.GenerateInput) (*llm.GenerateOutput, error) {
	if !input.DisableTools || len(input.Tools) != 0 {
		return nil, fmt.Errorf("审批模型启用了工具")
	}
	if g.err != nil {
		return nil, g.err
	}
	if g.response != "bound" {
		return &llm.GenerateOutput{Text: g.response}, nil
	}
	var item repository.ToolApproval
	if err := json.Unmarshal([]byte(input.Messages[1].Content), &item); err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(map[string]string{"decision": "allow", "parameters_hash": item.ParametersHash, "workspace_version": item.WorkspaceVersion})
	return &llm.GenerateOutput{Text: string(raw)}, nil
}
func TestToolApprovalAutoRequiresBoundStructuredDecision(t *testing.T) {
	g := &approvalGatewayStub{}
	s := &Service{approvalSettings: &approvalSettingsStub{}, approvalRoutes: &approvalRouteStub{}, llmClient: g}
	item := repository.ToolApproval{ParametersHash: "hash", WorkspaceVersion: "version"}
	for _, response := range []string{"", `{"decision":"allow"}`, `{"decision":"allow","parameters_hash":"wrong","workspace_version":"version"}`, `{"decision":"allow","parameters_hash":"hash","workspace_version":"version"} trailing`} {
		g.response = response
		if allow, err := s.autoApproveTool(t.Context(), item); allow || err == nil {
			t.Fatalf("无效结果被允许: %q", response)
		}
	}
	g.response = "bound"
	if allow, err := s.autoApproveTool(t.Context(), item); !allow || err != nil {
		t.Fatalf("绑定的允许结果未通过: %v", err)
	}
	g.err = errors.New("上游错误")
	if allow, err := s.autoApproveTool(t.Context(), item); allow || err == nil {
		t.Fatal("上游错误被放行")
	}
}

type approvalTestRepo struct {
	item     repository.ToolApproval
	onCreate func(*repository.ToolApproval)
}

func (r *approvalTestRepo) CreateToolApproval(_ context.Context, item *repository.ToolApproval) error {
	r.item = *item
	if r.onCreate != nil {
		r.onCreate(&r.item)
	}
	return nil
}
func (r *approvalTestRepo) GetToolApproval(_ context.Context, user uint, id string) (*repository.ToolApproval, error) {
	if r.item.UserID != user || r.item.ID != id {
		return nil, repository.ErrNotFound
	}
	item := r.item
	return &item, nil
}
func (r *approvalTestRepo) ListToolApprovals(context.Context, uint) ([]repository.ToolApproval, error) {
	return []repository.ToolApproval{r.item}, nil
}
func (r *approvalTestRepo) ChangeToolApproval(_ context.Context, user uint, id, from, to string) error {
	if r.item.UserID != user || r.item.ID != id || r.item.Status != from {
		return repository.ErrConflict
	}
	r.item.Status = to
	return nil
}

func TestToolApprovalDecisionsRequireOwnerAndPendingManual(t *testing.T) {
	repo := &approvalTestRepo{item: repository.ToolApproval{ID: "a", UserID: 1, Mode: "manual", Status: "pending", ExpiresAt: time.Now().Add(time.Minute)}}
	s := &Service{toolApprovals: repo}
	if err := s.DecideToolApproval(t.Context(), 2, "a", true); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("非owner确认: %v", err)
	}
	if err := s.DecideToolApproval(t.Context(), 1, "a", false); err != nil || repo.item.Status != "denied" {
		t.Fatalf("拒绝未生效: %v", err)
	}
	if err := s.DecideToolApproval(t.Context(), 1, "a", true); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("拒绝后重放: %v", err)
	}
	repo.item.Status = "pending"
	repo.item.Mode = "auto"
	if err := s.DecideToolApproval(t.Context(), 1, "a", true); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("手动接口覆盖自动审批")
	}
	repo.item.Mode = "manual"
	repo.item.ExpiresAt = time.Now().Add(-time.Second)
	if err := s.DecideToolApproval(t.Context(), 1, "a", true); !errors.Is(err, repository.ErrConflict) {
		t.Fatal("过期审批被允许")
	}
}

func TestToolApprovalGateModesAndCancellation(t *testing.T) {
	s, base := newProjectVersionTestService(t, "hello")
	repo := &approvalTestRepo{}
	s.toolApprovals = repo
	input := ExecuteToolInput{UserID: 1, ConversationID: 3, ProjectPublicID: "project", RunID: "run", ToolCallID: "call", ToolName: "project_patch_file", ArgumentsJSON: `{"file":"a.txt","old":"hello","new":"world"}`}
	repo.onCreate = func(item *repository.ToolApproval) { item.Status = "denied" }
	if err := s.approveToolExecution(t.Context(), input); err == nil {
		t.Fatal("拒绝后放行")
	}
	repo.onCreate = func(item *repository.ToolApproval) { item.Status = "approved" }
	if err := s.approveToolExecution(t.Context(), input); err != nil || repo.item.Status != "consumed" {
		t.Fatalf("批准未消费: %v", err)
	}
	repo.onCreate = func(item *repository.ToolApproval) { item.Status = "approved"; base.file.Version++ }
	if err := s.approveToolExecution(t.Context(), input); err == nil || repo.item.Status != "stale" {
		t.Fatal("工作区变化未拒绝")
	}
	ctx, cancel := context.WithCancel(t.Context())
	repo.onCreate = func(*repository.ToolApproval) { cancel() }
	if err := s.approveToolExecution(ctx, input); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消未退出: %v", err)
	}
	input.AgentPermissions.Mode = "full"
	if err := s.approveToolExecution(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	input.AgentPermissions.Mode = "auto"
	if err := s.approveToolExecution(t.Context(), input); err == nil {
		t.Fatal("未配置自动审批模型却放行")
	}
}
