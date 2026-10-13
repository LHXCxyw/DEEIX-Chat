package conversation

import (
	"strings"
	"testing"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

func TestInjectMCPToolGuidanceOnlyAddsPolicy(t *testing.T) {
	messages := []llm.Message{{Role: "user", Content: "搜索 DEEIX Chat"}}
	runtime := selectedToolRuntime{
		definitions: []llm.ToolDefinition{{
			Name:        "bing_search",
			Description: "搜索网页",
			InputSchema: []byte(`{"type":"object","properties":{"query":{"type":"string"},"count":{"type":"number"}},"required":["query"]}`),
		}},
	}

	result := injectMCPToolGuidance(messages, runtime, "")
	if len(result) != 2 {
		t.Fatalf("expected guidance message to be injected, got %#v", result)
	}
	guidance := result[0].Content
	for _, want := range []string{"# tool_use", "declared separately via the API schema", "Use the fewest useful calls"} {
		if !strings.Contains(guidance, want) {
			t.Fatalf("expected guidance to contain %q, got %q", want, guidance)
		}
	}
	for _, unwanted := range []string{"# tools", "bing_search", "query:string", "count:number"} {
		if strings.Contains(guidance, unwanted) {
			t.Fatalf("expected guidance not to duplicate tool schema %q, got %q", unwanted, guidance)
		}
	}
}

func TestInjectMCPToolGuidanceAppendsCustomPrompt(t *testing.T) {
	messages := []llm.Message{{Role: "user", Content: "搜索 DEEIX Chat"}}
	runtime := selectedToolRuntime{
		definitions: []llm.ToolDefinition{{Name: "bing_search"}},
	}

	result := injectMCPToolGuidance(messages, runtime, "Use MCP tools only after checking user intent.")
	if len(result) != 2 {
		t.Fatalf("expected guidance message to be injected, got %#v", result)
	}
	for _, want := range []string{"# tool_use", "declared separately via the API schema", "# custom_tool_use", "Use MCP tools only after checking user intent."} {
		if !strings.Contains(result[0].Content, want) {
			t.Fatalf("expected guidance to contain %q, got %q", want, result[0].Content)
		}
	}
	if strings.Index(result[0].Content, "# custom_tool_use") < strings.Index(result[0].Content, "# tool_use") {
		t.Fatalf("expected custom prompt to be appended after built-in guidance, got %q", result[0].Content)
	}
}

func TestInjectMCPToolGuidanceOmitsProjectPolicyWithoutProjectTools(t *testing.T) {
	messages := []llm.Message{{Role: "user", Content: "搜索 DEEIX Chat"}}
	runtime := selectedToolRuntime{definitions: []llm.ToolDefinition{{Name: "bing_search"}}}

	result := injectMCPToolGuidance(messages, runtime, "")
	if len(result) != 2 {
		t.Fatalf("expected guidance message to be injected, got %#v", result)
	}
	for _, unwanted := range []string{"project_*", "Project file operations", "Read an existing file before modifying it"} {
		if strings.Contains(result[0].Content, unwanted) {
			t.Fatalf("expected guidance not to contain project policy %q, got %q", unwanted, result[0].Content)
		}
	}
}
