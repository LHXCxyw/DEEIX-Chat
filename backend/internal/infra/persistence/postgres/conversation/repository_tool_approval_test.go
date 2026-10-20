package conversation

import (
	"testing"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func TestToolApprovalListMapsOnlyOwnedLiveConversations(t *testing.T) {
	db := openConversationRepositoryTestDB(t)
	if err := db.AutoMigrate(&repository.ToolApproval{}); err != nil {
		t.Fatal(err)
	}
	conversations := []models.Conversation{
		{UserID: 1, PublicID: "owned", SessionKey: "owned", Status: "active"},
		{UserID: 2, PublicID: "other-private", SessionKey: "other", Status: "active"},
		{UserID: 1, PublicID: "deleting", SessionKey: "deleting", Status: "deleting"},
		{UserID: 1, PublicID: "deleted", SessionKey: "deleted", Status: "active"},
	}
	for i := range conversations {
		if err := db.Create(&conversations[i]).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Delete(&conversations[3]).Error; err != nil {
		t.Fatal(err)
	}
	items := []repository.ToolApproval{
		{ID: "valid", UserID: 1, ConversationID: conversations[0].ID},
		{ID: "wrong-conversation-owner", UserID: 1, ConversationID: conversations[1].ID},
		{ID: "wrong-approval-owner", UserID: 2, ConversationID: conversations[0].ID},
		{ID: "deleting", UserID: 1, ConversationID: conversations[2].ID},
		{ID: "deleted", UserID: 1, ConversationID: conversations[3].ID},
		{ID: "missing", UserID: 1, ConversationID: 9999},
		{ID: "expired", UserID: 1, ConversationID: conversations[0].ID},
		{ID: "consumed", UserID: 1, ConversationID: conversations[0].ID},
	}
	r := NewRepo(db)
	for i := range items {
		items[i].Status = "pending"
		items[i].ExpiresAt = time.Now().Add(time.Minute)
		if items[i].ID == "expired" {
			items[i].ExpiresAt = time.Now().Add(-time.Minute)
		}
		if items[i].ID == "consumed" {
			items[i].Status = "consumed"
		}
		if err := r.CreateToolApproval(t.Context(), &items[i]); err != nil {
			t.Fatal(err)
		}
	}
	got, err := r.ListToolApprovals(t.Context(), 1)
	if err != nil || len(got) != 1 {
		t.Fatalf("审批列表错误: %+v %v", got, err)
	}
	if got[0].ID != "valid" || got[0].ConversationPublicID != "owned" {
		t.Fatalf("会话映射错误: %+v", got[0])
	}
	var columns []struct{ Name string }
	if err := db.Raw("PRAGMA table_info(tool_approvals)").Scan(&columns).Error; err != nil {
		t.Fatal(err)
	}
	for _, column := range columns {
		if column.Name == "conversation_public_id" {
			t.Fatal("公开会话映射不应持久化")
		}
	}
}
