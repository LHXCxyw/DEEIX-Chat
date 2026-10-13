package conversation

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	portllm "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

func TestNormalizeProjectFilePath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "normalizes separators", input: ` src\main.go `, want: "src/main.go"},
		{name: "rejects empty", input: " ", wantErr: true},
		{name: "rejects parent traversal", input: "../secret", wantErr: true},
		{name: "rejects absolute path", input: "/etc/passwd", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeProjectFilePath(tt.input)
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidFileReference) {
					t.Fatalf("normalizeProjectFilePath() error = %v, want ErrInvalidFileReference", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeProjectFilePath() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("normalizeProjectFilePath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestProjectToolGuidanceRequiresFileToolCalls(t *testing.T) {
	t.Parallel()

	runtime := selectedToolRuntime{definitions: []portllm.ToolDefinition{{Name: "project_read_file"}}}
	guidance := defaultMCPToolGuidancePrompt(runtime)
	for _, required := range []string{"MUST use the corresponding project_* tool", "Never substitute a code block", "Read an existing file before modifying it"} {
		if !strings.Contains(guidance, required) {
			t.Fatalf("default guidance missing %q", required)
		}
	}
}

func TestProjectToolDefinitionsDescribeWriteAndDeleteAsMandatory(t *testing.T) {
	t.Parallel()

	runtime := selectedToolRuntime{nameMap: map[string]string{}, schemas: map[string]json.RawMessage{}}
	addProjectToolDefinitions(&runtime)
	descriptions := map[string]string{}
	for _, definition := range runtime.definitions {
		descriptions[definition.Name] = definition.Description
	}
	for _, name := range []string{"project_write_file", "project_delete_file"} {
		if !strings.Contains(descriptions[name], "必须调用") {
			t.Fatalf("%s description does not require a tool call", name)
		}
	}
}
