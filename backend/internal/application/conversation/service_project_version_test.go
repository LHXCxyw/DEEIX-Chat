package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type projectVersionTestRepo struct {
	repository.ConversationRepository
	file                        model.ProjectFile
	lists                       int
	onList                      func(*projectVersionTestRepo)
	casErr                      error
	duplicate                   bool
	onCreate                    func(*projectVersionTestRepo)
	cas, legacy, changes, usage int
}

func (r *projectVersionTestRepo) GetConversationByUser(context.Context, uint, uint) (*model.Conversation, error) {
	id := uint(1)
	return &model.Conversation{ID: 3, UserID: 1, ProjectID: &id}, nil
}

func (r *projectVersionTestRepo) GetConversationProjectByPublicID(context.Context, uint, string) (*model.ConversationProject, error) {
	return &model.ConversationProject{ID: 1}, nil
}
func (r *projectVersionTestRepo) GetOrCreateProjectWorkspace(context.Context, uint, uint, string) (*model.ProjectWorkspace, error) {
	return &model.ProjectWorkspace{ID: 2, OwnerUserID: 1}, nil
}
func (r *projectVersionTestRepo) GetProjectWorkspaceByProject(context.Context, uint, uint) (*model.ProjectWorkspace, error) {
	return &model.ProjectWorkspace{ID: 2, OwnerUserID: 1}, nil
}
func (r *projectVersionTestRepo) ListProjectFiles(context.Context, uint, uint) ([]model.ProjectFile, error) {
	r.lists++
	if r.onList != nil {
		r.onList(r)
	}
	if r.file.PublicID == "" {
		return nil, nil
	}
	return []model.ProjectFile{r.file}, nil
}
func (r *projectVersionTestRepo) CompareAndSwapProjectFile(_ context.Context, _ uint, _ uint, id, key, mime string, size int64, hash string, version int) (*model.ProjectFile, error) {
	r.cas++
	if r.casErr != nil {
		return nil, r.casErr
	}
	if id != r.file.PublicID || version != r.file.Version {
		return nil, repository.ErrConflict
	}
	r.file.Version++
	r.file.StorageKey = key
	r.file.SizeBytes = size
	return &r.file, nil
}
func (r *projectVersionTestRepo) UpdateProjectFile(_ context.Context, _ uint, _ uint, id, key, mime string, size int64, hash string, version int) (*model.ProjectFile, error) {
	r.legacy++
	r.file.Version = version
	r.file.StorageKey = key
	return &r.file, nil
}
func (r *projectVersionTestRepo) UpdateProjectWorkspaceUsage(context.Context, uint, uint, int64, int) error {
	r.usage++
	return nil
}
func (r *projectVersionTestRepo) CreateProjectFileChanges(context.Context, uint, uint, []model.ProjectFileChange) error {
	r.changes++
	return nil
}
func (r *projectVersionTestRepo) PurgeProjectFileByPath(context.Context, uint, uint, string) error {
	return nil
}
func (r *projectVersionTestRepo) CreateProjectFile(_ context.Context, file *model.ProjectFile) error {
	if r.onCreate != nil {
		r.onCreate(r)
	}
	if r.duplicate {
		return repository.ErrDuplicate
	}
	r.file = *file
	return nil
}

type projectVersionStoreProvider struct{ store objectstorage.Store }

func (p *projectVersionStoreProvider) Open(context.Context) (objectstorage.Store, error) {
	return p.store, nil
}

func newProjectVersionTestService(t *testing.T, content string) (*Service, *projectVersionTestRepo) {
	t.Helper()
	store := objectstorage.NewLocal(t.TempDir())
	if _, err := store.Put(context.Background(), "snapshot", strings.NewReader(content), objectstorage.PutOptions{SizeBytes: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	repo := &projectVersionTestRepo{file: model.ProjectFile{PublicID: "file", RelativePath: "a.txt", EntryType: model.ProjectFileEntryTypeFile, StorageKey: "snapshot", Version: 1}}
	return &Service{repo: repo, storeProvider: &projectVersionStoreProvider{store: store}}, repo
}

func TestWriteProjectFileExpectedVersion(t *testing.T) {
	for _, name := range []string{"success", "stale", "missing", "negative", "database race", "legacy", "legacy race", "legacy missing race", "create", "create race"} {
		t.Run(name, func(t *testing.T) {
			service, repo := newProjectVersionTestService(t, "old")
			version := 1
			var want error
			switch name {
			case "stale":
				version = 2
				want = ErrProjectFileVersionConflict
			case "missing":
				repo.file = model.ProjectFile{}
				want = ErrProjectFileVersionConflict
			case "negative":
				version = -1
				want = ErrInvalidProjectFileVersion
			case "database race", "legacy race":
				repo.casErr = repository.ErrConflict
				want = ErrProjectFileVersionConflict
			case "legacy missing race":
				repo.casErr = repository.ErrNotFound
				want = ErrProjectFileVersionConflict
			case "create", "create race":
				repo.file = model.ProjectFile{}
				version = 0
				if name == "create race" {
					repo.duplicate = true
					want = ErrProjectFileVersionConflict
				}
			}
			var err error
			if strings.HasPrefix(name, "legacy") {
				_, err = service.WriteProjectFile(context.Background(), 1, "project", "a.txt", []byte("new"), UserFileChangeContext())
			} else {
				_, err = service.WriteProjectFile(context.Background(), 1, "project", "a.txt", []byte("new"), UserFileChangeContext(), &version)
			}
			if !errors.Is(err, want) {
				t.Fatalf("error=%v,want %v", err, want)
			}
			if want != nil && (repo.changes != 0 || repo.usage != 0 || repo.legacy != 0) {
				t.Fatalf("conflict side effects: %+v", repo)
			}
			if (name == "success" || name == "legacy") && (repo.cas != 1 || repo.file.Version != 2 || repo.legacy != 0) {
				t.Fatalf("CAS not used: %+v", repo)
			}
			if want != nil && (repo.file.StorageKey != "snapshot" && repo.file.PublicID != "") {
				t.Fatal("failed save changed the stored file")
			}
		})
	}
}

func TestWriteProjectFileLegacyCreateRaceUsesCAS(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(fmt.Sprint(conflict), func(t *testing.T) {
			service, repo := newProjectVersionTestService(t, "old")
			winner := repo.file
			repo.file = model.ProjectFile{}
			repo.duplicate = true
			repo.onCreate = func(r *projectVersionTestRepo) { r.file = winner }
			if conflict {
				repo.casErr = repository.ErrConflict
			}
			_, err := service.WriteProjectFile(context.Background(), 1, "project", "a.txt", []byte("new"), UserFileChangeContext())
			if repo.cas != 1 || repo.legacy != 0 {
				t.Fatalf("CAS not used: %+v", repo)
			}
			if conflict {
				if !errors.Is(err, ErrProjectFileVersionConflict) || repo.changes != 0 || repo.usage != 0 || repo.file.StorageKey != "snapshot" {
					t.Fatalf("conflict error=%v repo=%+v", err, repo)
				}
			} else if err != nil || repo.file.Version != 2 || repo.changes != 1 || repo.usage != 1 {
				t.Fatalf("save error=%v repo=%+v", err, repo)
			}
		})
	}
}

func TestProjectToolDiffSnapshots(t *testing.T) {
	for _, tt := range []struct {
		name, tool, before, after, args string
		create                          bool
	}{
		{"create", "project_write_file", "", "hello\nworld\n", `{"path":"a.txt","content":"hello\nworld\n"}`, true},
		{"overwrite", "project_write_file", "hello\nworld\n", "hello\nthere\n", `{"path":"a.txt","content":"hello\nthere\n"}`, false},
		{"patch", "project_patch_file", "hello\nworld\n", "hi\nthere\n", `{"file":"a.txt","patches":[{"old":"hello","new":"hi"},{"old":"world","new":"there"}]}`, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s, repo := newProjectVersionTestService(t, tt.before)
			if tt.create {
				repo.file = model.ProjectFile{}
			}
			raw, err := s.executeProjectTool(context.Background(), ExecuteToolInput{UserID: 1, ConversationID: 3, AgentPermissions: AgentPermissions{EditFiles: true}, ProjectPublicID: "project", ToolName: tt.tool, ArgumentsJSON: tt.args})
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Diff *projectToolDiff `json:"file_diff"`
			}
			if err := json.Unmarshal([]byte(raw), &result); err != nil {
				t.Fatal(err)
			}
			if result.Diff == nil || result.Diff.Before != tt.before || result.Diff.After != tt.after || result.Diff.Created != tt.create || result.Diff.Truncated {
				t.Fatalf("snapshot=%+v", result.Diff)
			}
			_, _, trace := buildToolTrace([]model.ToolCall{{ToolName: tt.tool, Status: "success", OutputJSON: raw, InputJSON: strings.Repeat("x", 10000)}})
			if trace.ToolCalls[0].FileDiff == nil || *trace.ToolCalls[0].FileDiff != *result.Diff {
				t.Fatal("trace lost snapshot")
			}
		})
	}
	for _, value := range []string{strings.Repeat("x", 33*1024), strings.Repeat("x\n", 1002)} {
		diff := newProjectToolDiff("a.txt", "", value, true)
		if !diff.Truncated || diff.Before != "" || diff.After != "" {
			t.Fatal("oversized snapshot not bounded")
		}
	}
}

func TestProjectPatchSnapshotAndUniqueMatch(t *testing.T) {
	for _, tt := range []struct {
		name, content, args string
		race                bool
		want                string
	}{
		{name: "single", content: "hello", args: `{"file":"a.txt","old":"hello","new":"world"}`},
		{name: "multiple", content: "hello world", args: `{"file":"a.txt","patches":[{"old":"hello","new":"hi"},{"old":"world","new":"there"}]}`},
		{name: "ambiguous", content: "hello hello", args: `{"file":"a.txt","old":"hello","new":"world"}`, want: "ambiguous"},
		{name: "overlap", content: "aaa", args: `{"file":"a.txt","old":"aa","new":"b"}`, want: "ambiguous"},
		{name: "missing", content: "hello", args: `{"file":"a.txt","old":"absent","new":"b"}`, want: "not found"},
		{name: "empty", content: "hello", args: `{"file":"a.txt","old":"","new":"b"}`, want: "empty"},
		{name: "stale", content: "hello", args: `{"file":"a.txt","old":"hello","new":"world"}`, race: true, want: "version conflict"},
		{name: "later ambiguous", content: "a bb", args: `{"file":"a.txt","patches":[{"old":"a","new":"c"},{"old":"b","new":"d"}]}`, want: "ambiguous"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			service, repo := newProjectVersionTestService(t, tt.content)
			if tt.race {
				repo.onList = func(r *projectVersionTestRepo) {
					if r.lists == 2 {
						r.file.Version = 2
					}
				}
			}
			_, err := service.executeProjectTool(context.Background(), ExecuteToolInput{UserID: 1, ConversationID: 3, AgentPermissions: AgentPermissions{EditFiles: true}, ProjectPublicID: "project", ToolName: "project_patch_file", ArgumentsJSON: tt.args})
			if tt.want == "" {
				if err != nil || repo.cas != 1 || repo.legacy != 0 {
					t.Fatalf("patch error=%v repo=%+v", err, repo)
				}
			} else {
				if err == nil || !strings.Contains(err.Error(), tt.want) {
					t.Fatalf("error=%v, want %s", err, tt.want)
				}
				if repo.cas != 0 || repo.legacy != 0 || repo.changes != 0 || repo.usage != 0 || repo.file.StorageKey != "snapshot" {
					t.Fatal("failed patch wrote file")
				}
			}
		})
	}
}
