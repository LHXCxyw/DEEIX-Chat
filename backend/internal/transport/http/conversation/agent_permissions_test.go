package conversation

import (
	"encoding/json"
	"errors"
	appconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	"testing"
)

func TestSendMessageAgentPermissionsContract(t *testing.T) {
	for _, tt := range []struct {
		body              string
		edit, unsupported bool
	}{
		{`{"contentType":"text","content":"hello"}`, false, false},
		{`{"agent_permissions":{"edit_files":true}}`, true, false},
		{`{"agent_permissions":{"execute_code":true}}`, false, false},
		{`{"agent_permissions":{"browse_project":true}}`, false, true},
		{`{"agent_permissions":{"browse_public":true}}`, false, true},
		{`{"agent_permissions":{"extract_archives":true}}`, false, true},
	} {
		var request SendMessageRequest
		if err := json.Unmarshal([]byte(tt.body), &request); err != nil {
			t.Fatal(err)
		}
		if request.AgentPermissions.EditFiles != tt.edit {
			t.Fatal("edit_files 契约不匹配")
		}
		err := appconversation.ValidateAgentPermissions(request.AgentPermissions)
		if errors.Is(err, appconversation.ErrAgentPermissionUnsupported) != tt.unsupported {
			t.Fatalf("unsupported=%v", err)
		}
	}
	var request SendMessageRequest
	if err := json.Unmarshal([]byte(`{"agent_permissions":{"edit_files":"true"}}`), &request); err == nil {
		t.Fatal("非布尔权限被接受")
	}
}
