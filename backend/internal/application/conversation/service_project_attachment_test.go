package conversation

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type attachmentImportRepo struct {
	*projectVersionTestRepo
	attachment model.FileObject
	projectErr error
	reads      int
}

func (r *attachmentImportRepo) GetConversationProjectByPublicID(_ context.Context, userID uint, id string) (*model.ConversationProject, error) {
	if r.projectErr != nil || userID != 1 || id != "project" {
		return nil, repository.ErrNotFound
	}
	return &model.ConversationProject{ID: 1}, nil
}

func (r *attachmentImportRepo) GetActiveFileObjectByID(_ context.Context, userID uint, id string) (*model.FileObject, error) {
	r.reads++
	if userID != r.attachment.UserID || id != r.attachment.FileID || r.attachment.Status != "active" {
		return nil, repository.ErrNotFound
	}
	item := r.attachment
	return &item, nil
}

func (r *attachmentImportRepo) TouchFileObjectLastAccessedAt(context.Context, uint, string, time.Time) error {
	return nil
}

func TestImportProjectFileFromAttachment(t *testing.T) {
	for _, name := range []string{"success", "unauthorized", "other user", "missing", "inactive", "project denied", "traversal", "existing", "create race", "zip", "zip mime", "binary", "invalid utf8", "large metadata", "large stream"} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			service, versionRepo := newProjectVersionTestService(t, "original")
			versionRepo.file = model.ProjectFile{}
			repo := &attachmentImportRepo{projectVersionTestRepo: versionRepo, attachment: model.FileObject{FileID: "attachment", UserID: 1, Status: "active", FileName: "source.go", MimeType: "text/plain", StoragePath: "attachment"}}
			input := ProjectAttachmentInput{UserID: 1, ProjectPublicID: "project", FileID: "attachment", Path: "src/main.go", EditAuthorized: true}
			content := "package main\n// 工作副本\n"
			var want error
			switch name {
			case "unauthorized":
				input.EditAuthorized = false
				want = ErrProjectAttachmentEditAuthorizationRequired
			case "other user":
				repo.attachment.UserID = 2
				want = ErrFileNotFound
			case "missing":
				input.FileID = "missing"
				want = ErrFileNotFound
			case "inactive":
				repo.attachment.Status = "deleted"
				want = ErrFileNotFound
			case "project denied":
				repo.projectErr = repository.ErrNotFound
				want = ErrConversationProjectNotFound
			case "traversal":
				input.Path = "src/../secret"
				want = ErrInvalidFileReference
			case "existing":
				versionRepo.file = model.ProjectFile{PublicID: "existing", RelativePath: input.Path, Version: 1}
				want = ErrProjectFileVersionConflict
			case "create race":
				versionRepo.duplicate = true
				want = ErrProjectFileVersionConflict
			case "zip":
				repo.attachment.FileName = "source.ZIP"
				want = ErrMIMEBlocked
			case "zip mime":
				repo.attachment.DetectedMIME = "application/zip"
				want = ErrMIMEBlocked
			case "binary":
				content = "a\x00b"
				want = ErrMIMEBlocked
			case "invalid utf8":
				content = "\xff"
				want = ErrMIMEBlocked
			case "large metadata":
				repo.attachment.SizeBytes = maxProjectAttachmentBytes + 1
				want = ErrFileTooLarge
			case "large stream":
				content = strings.Repeat("x", maxProjectAttachmentBytes+1)
				want = ErrFileTooLarge
			}
			store, err := service.storeProvider.Open(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = store.Put(ctx, "attachment", strings.NewReader(content), objectstorage.PutOptions{SizeBytes: int64(len(content))}); err != nil {
				t.Fatal(err)
			}
			service.repo = repo
			service.uploadSvc = appupload.NewServiceWithRuntime(nil, repo, nil, appupload.Hooks{}, appupload.ErrorSet{FileNotFound: ErrFileNotFound}, "")
			service.uploadSvc.SetObjectStoreProvider(service.storeProvider)
			item, err := service.ImportProjectFileFromAttachment(ctx, input)
			if !errors.Is(err, want) {
				t.Fatalf("error=%v, want=%v", err, want)
			}
			if want == nil {
				if item.Version != 1 || item.RelativePath != input.Path || item.StorageKey == "attachment" || repo.changes != 1 {
					t.Fatalf("invalid working copy: %+v", item)
				}
				reader, _, err := store.Open(ctx, item.StorageKey)
				if err != nil {
					t.Fatal(err)
				}
				copied, err := io.ReadAll(reader)
				reader.Close()
				if err != nil || string(copied) != content {
					t.Fatalf("copy=%q error=%v", copied, err)
				}
			} else if repo.changes != 0 || repo.cas != 0 || repo.usage != 0 {
				t.Fatal("rejected import changed workspace")
			}
			reader, _, err := store.Open(ctx, "attachment")
			if err != nil {
				t.Fatal(err)
			}
			original, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || string(original) != content {
				t.Fatal("original changed")
			}
			if (name == "unauthorized" || name == "project denied" || name == "traversal") && repo.reads != 0 {
				t.Fatal("rejected input read attachment")
			}
		})
	}
}

func TestProjectAttachmentTextAndPath(t *testing.T) {
	for _, value := range []string{"", "..", "a/../../b", "/etc/passwd", `C:\secret`, `\\server\share`, "a\x00b", "a\nb", "a:b", "a/.. /b"} {
		if _, err := normalizeProjectAttachmentPath(value); !errors.Is(err, ErrInvalidFileReference) {
			t.Fatalf("path %q error=%v", value, err)
		}
	}
	for _, content := range []string{"", "你好\n\t", "<html>hello</html>", strings.Repeat("x", maxProjectAttachmentBytes)} {
		if _, err := readProjectAttachmentText(strings.NewReader(content)); err != nil {
			t.Fatalf("text rejected: %v", err)
		}
	}
	for _, content := range []string{"PK\x03\x04", "PK\x05\x06", "%PDF-1.7\n", "\xff", "text\x00", "text\x1b"} {
		if _, err := readProjectAttachmentText(strings.NewReader(content)); !errors.Is(err, ErrMIMEBlocked) {
			t.Fatalf("binary %q error=%v", content, err)
		}
	}
	if _, err := readProjectAttachmentText(strings.NewReader(strings.Repeat("x", maxProjectAttachmentBytes+1))); !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("size error=%v", err)
	}
}
