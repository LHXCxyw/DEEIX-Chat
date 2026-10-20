package conversation

import (
	"context"
	"errors"
	"testing"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func TestConversationWorkspaceOwnership(t *testing.T) {
	db := openConversationRepositoryTestDB(t)
	if err := db.AutoMigrate(&models.ProjectWorkspace{}); err != nil {
		t.Fatal(err)
	}
	conversations := []models.Conversation{{UserID: 1, PublicID: "one", SessionKey: "one"}, {UserID: 1, PublicID: "two", SessionKey: "two"}, {UserID: 2, PublicID: "other", SessionKey: "other"}}
	for i := range conversations {
		if err := db.Create(&conversations[i]).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := NewRepo(db)
	ctx := context.Background()
	first, err := repo.GetOrCreateConversationWorkspace(ctx, 1, conversations[0].ID, "first")
	if err != nil {
		t.Fatal(err)
	}
	again, err := repo.GetOrCreateConversationWorkspace(ctx, 1, conversations[0].ID, "unused")
	if err != nil || again.ID != first.ID || again.PublicID != "first" {
		t.Fatalf("again=%+v err=%v", again, err)
	}
	second, err := repo.GetOrCreateConversationWorkspace(ctx, 1, conversations[1].ID, "second")
	if err != nil || second.ID == first.ID {
		t.Fatalf("second=%+v err=%v", second, err)
	}
	if first.ConversationProjectID != 0 || first.ConversationID == nil || *first.ConversationID != conversations[0].ID {
		t.Fatalf("workspace=%+v", first)
	}
	for _, id := range []uint{conversations[2].ID, 9999} {
		if _, err := repo.GetOrCreateConversationWorkspace(ctx, 1, id, "denied"); !errors.Is(err, repository.ErrNotFound) {
			t.Fatalf("ownership=%v", err)
		}
	}
	if _, err := repo.GetConversationWorkspace(ctx, 2, conversations[0].ID); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("read ownership=%v", err)
	}
	projectID := uint(99)
	if err := db.Model(&conversations[0]).Update("project_id", projectID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := repo.GetConversationWorkspace(ctx, 1, conversations[0].ID); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("project scope=%v", err)
	}
	if err := db.Model(&conversations[0]).Update("project_id", nil).Error; err != nil {
		t.Fatal(err)
	}
	retained, err := repo.GetConversationWorkspace(ctx, 1, conversations[0].ID)
	if err != nil || retained.ID != first.ID {
		t.Fatalf("retained=%+v err=%v", retained, err)
	}
	var count int64
	if err := db.Model(&models.ConversationProject{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("hidden projects=%d err=%v", count, err)
	}
}
