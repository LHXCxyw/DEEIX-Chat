package conversation

import (
	"context"
	"strings"
	"testing"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

// 回归测试：项目工具没有 MCP 绑定（binding == nil）时不得在归属快照处空指针 panic。
// 此前 service_tool_execution.go 的 `row.MCPServerID = binding.ServerID` 对项目工具
// 必然解引用 nil，导致每次项目工具调用都在执行前崩溃整条运行（客户端只见 internal.error）。
func TestExecuteAssistantToolCallsProjectToolWithoutMCPServerBinding(t *testing.T) {
	service := &Service{}
	result := service.executeAssistantToolCalls(context.Background(), executeAssistantToolCallsInput{
		UserID:         1,
		ConversationID: 2,
		RunID:          "run_test",
		ToolCalls: []llm.ToolCall{{
			ToolCallID:   "call_1",
			ToolName:     "project_write_file",
			ArgumentsJSON: `{"path":"a.txt","content":"x"}`,
		}},
	})

	if len(result.Rows) != 1 {
		t.Fatalf("expected exactly one tool row, got %d", len(result.Rows))
	}
	if result.FatalErr != nil {
		t.Fatalf("project tool with nil binding must not be fatal, got %v", result.FatalErr)
	}
	row := result.Rows[0]
	// repo 未配置时工具执行会失败，但必须是结构化错误行（回灌给模型），而不是 panic。
	if row.Status != "error" {
		t.Fatalf("expected error row without repo, got status=%q", row.Status)
	}
	if !strings.Contains(row.ErrorJSON, "project context is required") {
		t.Fatalf("unexpected tool error: %q", row.ErrorJSON)
	}
	if row.MCPServerID != 0 || row.MCPServerName != "" {
		t.Fatalf("project tool must not carry MCP server attribution, got %d/%q", row.MCPServerID, row.MCPServerName)
	}
}

// executeToolCallSafely 必须把工具实现的 panic 转为错误返回，保证单工具故障不中断多轮运行。
func TestExecuteToolCallSafelyRecoversPanic(t *testing.T) {
	service := &Service{} // repo 为 nil，project 工具进入 executeProjectTool 后必然 panic
	_, err := service.executeToolCallSafely(context.Background(), ExecuteToolInput{
		ToolName:        "project_write_file",
		ProjectPublicID: "proj_public_id",
		ArgumentsJSON:   `{"path":"a.txt","content":"x"}`,
	})
	if err == nil || !strings.Contains(err.Error(), "tool execution panicked") {
		t.Fatalf("expected panic converted to tool error, got %v", err)
	}
}
