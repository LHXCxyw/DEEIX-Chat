package conversation

import (
	"context"
	"errors"
	"testing"

	models "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func TestProjectFileCompareAndSwap(t *testing.T) {
	db := openConversationRepositoryTestDB(t)
	if err := db.AutoMigrate(&models.ProjectFile{}, &models.ProjectWorkspace{}); err != nil {
		t.Fatal(err)
	}
	workspace := models.ProjectWorkspace{BaseModel: models.BaseModel{ID: 2}, OwnerUserID: 1, PublicID: "workspace", Status: "active"}
	if err := db.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}
	repo := NewRepo(db)
	ctx := context.Background()
	file := models.ProjectFile{PublicID: "file", OwnerUserID: 1, ProjectID: 2, RelativePath: "a.txt", FileName: "a.txt", EntryType: "file", StorageKey: "old", Version: 1}
	if err := db.Create(&file).Error; err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		owner, project uint
		id             string
		version        int
	}{{9, 2, "file", 1}, {1, 9, "file", 1}, {1, 2, "missing", 1}, {1, 2, "file", 0}} {
		if _, err := repo.CompareAndSwapProjectFile(ctx, test.owner, test.project, test.id, "wrong", "text/plain", 5, "hash", test.version); !errors.Is(err, repository.ErrConflict) {
			t.Fatalf("CAS error = %v", err)
		}
	}
	updated, err := repo.CompareAndSwapProjectFile(ctx, 1, 2, "file", "new", "text/plain", 3, "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 || updated.StorageKey != "new" || updated.PublicID != "file" {
		t.Fatalf("updated = %+v", updated)
	}
	if _, err = repo.CompareAndSwapProjectFile(ctx, 1, 2, "file", "lost", "text/plain", 4, "hash", 1); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("stale CAS = %v", err)
	}
	current, err := repo.GetProjectFile(ctx, 1, 2, "file")
	if err != nil || current.Version != 2 || current.StorageKey != "new" {
		t.Fatalf("current = %+v, %v", current, err)
	}
	if err = repo.PurgeProjectFileByPath(ctx, 1, 2, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.GetProjectFile(ctx, 1, 2, "file"); err != nil {
		t.Fatalf("purged active file: %v", err)
	}
	if err = db.Delete(&file).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = repo.CompareAndSwapProjectFile(ctx, 1, 2, "file", "lost", "text/plain", 4, "hash", 2); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("deleted CAS = %v", err)
	}
	if err = repo.PurgeProjectFileByPath(ctx, 1, 2, "a.txt"); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = db.Unscoped().Model(&models.ProjectFile{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("remaining = %d, %v", count, err)
	}
}
