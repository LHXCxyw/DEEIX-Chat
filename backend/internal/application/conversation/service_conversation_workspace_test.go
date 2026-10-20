package conversation

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type conversationWorkspaceTestRepo struct {
	*attachmentImportRepo
	projectID *uint
}

func (r *conversationWorkspaceTestRepo) GetConversationByPublicID(_ context.Context, id string, userID uint) (*model.Conversation, error) {
	if id != "conversation" || userID != 1 {
		return nil, repository.ErrNotFound
	}
	return &model.Conversation{ID: 7, UserID: 1, ProjectID: r.projectID}, nil
}
func (r *conversationWorkspaceTestRepo) GetOrCreateConversationWorkspace(_ context.Context, userID, conversationID uint, _ string) (*model.ProjectWorkspace, error) {
	if userID != 1 || conversationID != 7 {
		return nil, repository.ErrNotFound
	}
	return &model.ProjectWorkspace{ID: 1, OwnerUserID: 1, ConversationID: &conversationID}, nil
}
func (r *conversationWorkspaceTestRepo) GetConversationWorkspace(ctx context.Context, userID, conversationID uint) (*model.ProjectWorkspace, error) {
	return r.GetOrCreateConversationWorkspace(ctx, userID, conversationID, "")
}

func (r *conversationWorkspaceTestRepo) GetProjectFile(_ context.Context, userID, workspaceID uint, id string) (*model.ProjectFile, error) {
	if userID != 1 || workspaceID != 1 || id != r.file.PublicID {
		return nil, repository.ErrNotFound
	}
	return &r.file, nil
}

func TestConversationAttachmentWorkingCopy(t *testing.T) {
	for _, name := range []string{"success", "unauthorized", "other user", "other conversation", "project", "existing", "race", "zip", "traversal"} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			service, versionRepo := newProjectVersionTestService(t, "original")
			versionRepo.file = model.ProjectFile{}
			repo := &conversationWorkspaceTestRepo{attachmentImportRepo: &attachmentImportRepo{projectVersionTestRepo: versionRepo, attachment: model.FileObject{FileID: "attachment", UserID: 1, Status: "active", FileName: "source.txt", MimeType: "text/plain", StoragePath: "attachment"}}}
			service.repo = repo
			service.uploadSvc = appupload.NewServiceWithRuntime(nil, repo, nil, appupload.Hooks{}, appupload.ErrorSet{FileNotFound: ErrFileNotFound}, "")
			service.uploadSvc.SetObjectStoreProvider(service.storeProvider)
			store, err := service.storeProvider.Open(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = store.Put(ctx, "attachment", strings.NewReader("original"), objectstorage.PutOptions{SizeBytes: 8}); err != nil {
				t.Fatal(err)
			}
			input := ConversationAttachmentInput{UserID: 1, ConversationPublicID: "conversation", FileID: "attachment", Path: "copy.txt", EditAuthorized: true}
			var want error
			switch name {
			case "unauthorized":
				input.EditAuthorized = false
				want = ErrProjectAttachmentEditAuthorizationRequired
			case "other user":
				input.UserID = 2
				want = ErrConversationNotFound
			case "other conversation":
				input.ConversationPublicID = "missing"
				want = ErrConversationNotFound
			case "project":
				id := uint(1)
				repo.projectID = &id
				want = ErrInvalidFileReference
			case "existing":
				versionRepo.file = model.ProjectFile{PublicID: "existing", RelativePath: input.Path, Version: 1}
				want = ErrProjectFileVersionConflict
			case "race":
				versionRepo.duplicate = true
				want = ErrProjectFileVersionConflict
			case "zip":
				repo.attachment.FileName = "source.zip"
				want = ErrMIMEBlocked
			case "traversal":
				input.Path = "../copy.txt"
				want = ErrInvalidFileReference
			}
			item, err := service.ImportConversationFileFromAttachment(ctx, input)
			if !errors.Is(err, want) {
				t.Fatalf("err=%v want=%v", err, want)
			}
			if want != nil {
				if repo.changes != 0 || repo.cas != 0 || repo.usage != 0 {
					t.Fatal("拒绝请求改变了工作区")
				}
				return
			}
			if item.Version != 1 || item.StorageKey == "attachment" || repo.changes != 1 {
				t.Fatalf("copy=%+v", item)
			}
			content, err := service.OpenConversationWorkspaceFileContent(ctx, 1, "conversation", item.PublicID)
			if err != nil {
				t.Fatal(err)
			}
			defer content.Reader.Close()
			data, err := io.ReadAll(content.Reader)
			if err != nil || string(data) != "original" {
				t.Fatalf("content=%q err=%v", data, err)
			}
			view, err := service.GetConversationWorkspace(ctx, 1, "conversation")
			if err != nil || len(view.Files) != 1 {
				t.Fatalf("view=%+v err=%v", view, err)
			}
			if _, err = service.OpenConversationWorkspaceFileContent(ctx, 2, "conversation", item.PublicID); !errors.Is(err, ErrConversationNotFound) {
				t.Fatalf("ownership=%v", err)
			}
		})
	}
}
