package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type toolBatchCancelRepository struct {
	repository.ConversationRepository
	cancel context.CancelFunc
	calls  int
}

func (r *toolBatchCancelRepository) CreateConversationToolCall(_ context.Context, row *model.ToolCall) error {
	r.calls++
	row.ID = uint(r.calls)
	r.cancel()
	return nil
}

func TestToolBatchCancellationKeepsOnlyProcessedPairs(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		count     int
		preCancel bool
		want      int
	}{
		{name: "before first call", count: 2, preCancel: true, want: 0},
		{name: "between calls", count: 2, want: 1},
		{name: "during last call", count: 1, want: 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			repo := &toolBatchCancelRepository{cancel: cancel}
			service := &Service{repo: repo}
			ledger := newToolExecutionLedger()
			ledger.store("workspace_run_command", `{}`, toolExecutionRecord{
				row:    model.ToolCall{Status: "success", OutputJSON: `{"ok":true}`},
				result: llm.ToolResult{Status: "success", OutputJSON: `{"ok":true}`},
			})
			calls := []llm.ToolCall{
				{ToolCallID: "first", ToolName: "workspace_run_command", ArgumentsJSON: `{}`},
				{ToolCallID: "second", ToolName: "workspace_run_command", ArgumentsJSON: `{}`},
			}
			if scenario.preCancel {
				cancel()
			}
			result := service.executeAssistantToolCalls(ctx, executeAssistantToolCallsInput{
				ToolCalls:         calls[:scenario.count],
				ToolSchemas:       map[string]json.RawMessage{"workspace_run_command": json.RawMessage(`{"type":"object"}`)},
				Ledger:            ledger,
				ResultTokenBudget: 1000,
			})
			if !errors.Is(result.FatalErr, context.Canceled) {
				t.Fatalf("取消必须按 fatal 返回，实际为 %v", result.FatalErr)
			}
			if len(result.Rows) != scenario.want || len(result.ToolResults) != scenario.want || len(result.ExecutedToolCalls) != scenario.want || repo.calls != scenario.want || len(result.PersistedToolCallKeys) != scenario.want {
				t.Fatalf("未处理项不得进入汇总：rows=%d results=%d calls=%d persisted=%d keys=%d", len(result.Rows), len(result.ToolResults), len(result.ExecutedToolCalls), repo.calls, len(result.PersistedToolCallKeys))
			}
			for i, row := range result.Rows {
				if row.ToolCallID == "" || row.ToolCallID != result.ToolResults[i].ToolCallID || row.ToolCallID != result.ExecutedToolCalls[i].ToolCallID {
					t.Fatalf("工具调用及结果必须成对：row=%+v result=%+v call=%+v", row, result.ToolResults[i], result.ExecutedToolCalls[i])
				}
			}
		})
	}
}

func TestToolBatchContextBudget(t *testing.T) {
	start := time.Now()
	ctx, cancel := agentToolExecutionContext(context.Background(), AgentPermissions{ExecuteCode: true})
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok || deadline.Before(start.Add(30*time.Minute)) || deadline.After(time.Now().Add(30*time.Minute)) {
		t.Fatalf("当前批次应有30分钟预算：deadline=%v", deadline)
	}
	parent, parentCancel := context.WithTimeout(context.Background(), time.Second)
	defer parentCancel()
	child, childCancel := agentToolExecutionContext(parent, AgentPermissions{ExecuteCode: true})
	defer childCancel()
	parentDeadline, _ := parent.Deadline()
	if childDeadline, _ := child.Deadline(); !childDeadline.Equal(parentDeadline) {
		t.Fatal("批次预算不得延长调用方期限")
	}
}
