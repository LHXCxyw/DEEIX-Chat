package conversation

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	appstorage "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/objectstorage"
	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type deliveryRepositories interface {
	repository.ConversationRepository
	repository.UploadRepository
}

type deliveryRepo struct {
	deliveryRepositories
	ordinary   bool
	message    model.Message
	files      []model.ProjectFile
	object     *model.FileObject
	attachment []model.Attachment
	attachErr  error
}

func (r *deliveryRepo) GetConversationProjectByPublicID(_ context.Context, user uint, id string) (*model.ConversationProject, error) {
	if user != 1 || id != "project" {
		return nil, repository.ErrNotFound
	}
	return &model.ConversationProject{ID: 2, UserID: 1}, nil
}
func (r *deliveryRepo) GetConversationByUser(context.Context, uint, uint) (*model.Conversation, error) {
	if r.ordinary {
		return &model.Conversation{ID: 3, UserID: 1}, nil
	}
	id := uint(2)
	return &model.Conversation{ID: 3, UserID: 1, ProjectID: &id}, nil
}
func (r *deliveryRepo) GetMessageByID(context.Context, uint, uint) (*model.Message, error) {
	return &r.message, nil
}
func (r *deliveryRepo) GetConversationRunByRunID(context.Context, uint, string) (*model.Run, error) {
	return &model.Run{ConversationID: 3}, nil
}
func (r *deliveryRepo) GetProjectWorkspaceByProject(context.Context, uint, uint) (*model.ProjectWorkspace, error) {
	return &model.ProjectWorkspace{ID: 4, OwnerUserID: 1}, nil
}
func (r *deliveryRepo) GetConversationWorkspace(_ context.Context, user, conversation uint) (*model.ProjectWorkspace, error) {
	if user != 1 || conversation != 3 {
		return nil, repository.ErrNotFound
	}
	return &model.ProjectWorkspace{ID: 4, OwnerUserID: 1, ConversationID: &conversation}, nil
}
func (r *deliveryRepo) ListProjectFiles(context.Context, uint, uint) ([]model.ProjectFile, error) {
	return r.files, nil
}
func (r *deliveryRepo) CreateAttachments(_ context.Context, a []model.Attachment) error {
	if r.attachErr != nil {
		return r.attachErr
	}
	r.attachment = a
	return nil
}
func (r *deliveryRepo) GetUserByID(context.Context, uint) (*domainuser.User, error) {
	return &domainuser.User{ID: 1, PublicID: "owner", Status: domainuser.StatusActive}, nil
}
func (r *deliveryRepo) GetLatestActiveFileObjectBySHA(context.Context, uint, string, int64) (*model.FileObject, error) {
	return nil, nil
}
func (r *deliveryRepo) CreateFileObjectAndConsumeQuota(_ context.Context, f *model.FileObject, _ int64) (*model.StorageQuota, error) {
	r.object = f
	return &model.StorageQuota{}, nil
}
func (r *deliveryRepo) GetActiveFileObjectByID(_ context.Context, user uint, id string) (*model.FileObject, error) {
	if r.object == nil || user != r.object.UserID || id != r.object.FileID {
		return nil, repository.ErrNotFound
	}
	return r.object, nil
}
func (r *deliveryRepo) TouchFileObjectLastAccessedAt(context.Context, uint, string, time.Time) error {
	return nil
}

type deliveryStore struct{ archiveDeliveryStore }

func (s *deliveryStore) Put(_ context.Context, key string, body io.Reader, opts objectstorage.PutOptions) (objectstorage.ObjectInfo, error) {
	data, err := io.ReadAll(body)
	s.data[key] = string(data)
	return objectstorage.ObjectInfo{Key: key, SizeBytes: int64(len(data)), ContentType: opts.ContentType}, err
}

func TestProjectArchiveDeliveryFileObjectAndAuthorization(t *testing.T) {
	for _, scenario := range []string{"success", "ordinary", "foreign-user", "wrong-run", "wrong-role", "attachment-failure"} {
		t.Run(scenario, func(t *testing.T) {
			repo := &deliveryRepo{message: model.Message{ID: 5, UserID: 1, Role: "assistant", RunID: "run", Status: "pending"}, files: []model.ProjectFile{{EntryType: "file", RelativePath: "main.go", StorageKey: "version-1"}}}
			store := &deliveryStore{archiveDeliveryStore{data: map[string]string{"version-1": "original bytes"}}}
			cfg := config.NewRuntime(config.Config{MaxUploadFileBytes: 1 << 20, FileAllowedMIMETypes: "application/zip"})
			provider := appstorage.NewRuntimeProvider(cfg, func(context.Context, config.Config) (objectstorage.Store, error) { return store, nil })
			upload := appupload.NewServiceWithRuntime(cfg, repo, nil, appupload.Hooks{}, appupload.ErrorSet{FileNotFound: ErrFileNotFound}, "")
			upload.SetObjectStoreProvider(provider)
			service := &Service{repo: repo, uploadSvc: upload, storeProvider: provider}
			input := ExecuteToolInput{UserID: 1, AgentPermissions: AgentPermissions{EditFiles: true}, ConversationID: 3, MessageID: 5, RunID: "run", ProjectPublicID: "project"}
			switch scenario {
			case "ordinary":
				repo.ordinary = true
				input.ProjectPublicID = ""
			case "foreign-user":
				input.UserID = 2
			case "wrong-run":
				repo.message.RunID = "other"
			case "wrong-role":
				repo.message.Role = "user"
			case "attachment-failure":
				repo.attachErr = errors.New("附件写入失败")
			}
			output, err := service.createProjectArchiveDelivery(context.Background(), input)
			if scenario != "success" && scenario != "ordinary" {
				if err == nil || output != "" {
					t.Fatalf("失败不得返回成功: %s %v", output, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if repo.object == nil || repo.object.UserID != 1 || len(repo.attachment) != 1 || repo.attachment[0].MessageID != 5 || repo.attachment[0].FileID != repo.object.FileID {
				t.Fatalf("FileObject/消息关联错误: %#v %#v", repo.object, repo.attachment)
			}
			before := store.data[repo.object.StoragePath]
			store.data["version-1"] = "changed project"
			content, err := upload.OpenFileContent(context.Background(), 1, repo.object.FileID)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(content.Reader)
			content.Reader.Close()
			if err != nil || string(data) != before {
				t.Fatal("下载不再是固定字节")
			}
			if _, err = upload.OpenFileContent(context.Background(), 2, repo.object.FileID); err == nil {
				t.Fatal("越权下载成功")
			}
		})
	}
}
