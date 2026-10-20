package conversation

import (
	"context"
	"errors"
	"testing"

	domainconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func TestDeletionTombstoneRevokesConversationWorkspace(t *testing.T) {
	db := openConversationRepositoryTestDB(t)
	if err := db.AutoMigrate(&models.ProjectWorkspace{}); err != nil {
		t.Fatal(err)
	}
	item := models.Conversation{UserID: 1, PublicID: "delete-chat", SessionKey: "delete-chat", Status: "active"}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	r := NewRepo(db)
	ctx := context.Background()
	if _, err := r.GetOrCreateConversationWorkspace(ctx, 1, item.ID, "ws"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		targets, err := r.BeginConversationDeletion(ctx, 1, item.PublicID)
		if err != nil || len(targets) != 1 {
			t.Fatalf("墓碑不可重试: %v", err)
		}
	}
	if _, err := r.GetConversationByUser(ctx, item.ID, 1); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("会话未撤权: %v", err)
	}
	if _, err := r.GetOrCreateConversationWorkspace(ctx, 1, item.ID, "new"); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("墓碑后重建: %v", err)
	}
	if _, err := r.GetConversationWorkspace(ctx, 1, item.ID); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("墓碑后回读: %v", err)
	}
	if err := r.CreateProjectFile(ctx, &domainconversation.ProjectFile{OwnerUserID: 1, ProjectID: 1, PublicID: "late", RelativePath: "late.txt"}); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("墓碑后允许写入: %v", err)
	}
	var count int64
	if err := db.Model(&models.ProjectWorkspace{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("工作区不应物理删除: %d %v", count, err)
	}
}
