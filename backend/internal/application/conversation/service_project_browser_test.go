package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	appstorage "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/objectstorage"
	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	operation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/agentoperation"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	runtime "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

type projectBrowserExecutor struct {
	calls int
	repo  *commandOperationRepo
	png   []byte
	err   error
}

func (*projectBrowserExecutor) CheckReadiness(context.Context, string) error { return nil }
func (e *projectBrowserExecutor) Execute(ctx context.Context, r runtime.Request) (runtime.Result, error) {
	e.calls++
	var snapshot projectBrowserSnapshot
	if json.Unmarshal(r.Stdin, &snapshot) != nil || len(snapshot.Files) != 2 || e.repo.item.Status != operation.Running || r.Permission.Network != runtime.NetworkNone || strings.Join(r.Command, " ") != "/usr/local/bin/node /app/src/project-browser-cli.js" {
		panic("项目浏览器执行未绑定快照")
	}
	if err := r.BindContainer(ctx, runtime.ContainerIdentity{ID: strings.Repeat("b", 64), Owner: strings.Repeat("a", 64), TaskID: r.TaskID, OperationID: r.OperationID}); err != nil {
		return runtime.Result{}, err
	}
	out, _ := json.Marshal(map[string]any{"protocol": 1, "snapshot_hash": snapshot.Hash, "completed_actions": len(snapshot.Actions), "dom": []browserDOMNode{{Text: "untrusted"}}, "console_errors": []string{"untrusted error"}, "screenshot": json.RawMessage(screenshotJSON(e.png, snapshot.Hash))})
	return runtime.Result{ExitCode: 0, Output: out}, e.err
}
func TestProjectBrowserDeliveryAndApproval(t *testing.T) {
	for _, scenario := range []string{"成功", "manual", "auto", "hash错误", "路径穿越", "权限拒绝", "清理失败", "容量拒绝", "附件失败"} {
		t.Run(scenario, func(t *testing.T) {
			html := "<script src=\"app.js\"></script>"
			js := "document.body.textContent='ok'"
			repo := &deliveryRepo{ordinary: true, message: model.Message{ID: 5, UserID: 1, Role: "assistant", RunID: "run", Status: "pending"}, files: []model.ProjectFile{{EntryType: "file", RelativePath: "index.html", StorageKey: "html", SHA256: commandHash([]byte(html))}, {EntryType: "file", RelativePath: "app.js", StorageKey: "js", SHA256: commandHash([]byte(js))}}}
			store := &deliveryStore{archiveDeliveryStore{data: map[string]string{"html": html, "js": js}}}
			cfg := config.NewRuntime(config.Config{MaxUploadFileBytes: 4 << 20, FileAllowedMIMETypes: "image/png"})
			provider := appstorage.NewRuntimeProvider(cfg, func(context.Context, config.Config) (objectstorage.Store, error) { return store, nil })
			upload := appupload.NewServiceWithRuntime(cfg, repo, nil, appupload.Hooks{}, appupload.ErrorSet{FileNotFound: ErrFileNotFound}, "")
			upload.SetObjectStoreProvider(provider)
			service := &Service{repo: repo, uploadSvc: upload, storeProvider: provider}
			ops := &commandOperationRepo{}
			executor := &projectBrowserExecutor{repo: ops, png: screenshotPNG(t)}
			image := "local/browser@sha256:" + strings.Repeat("c", 64)
			if err := service.SetProjectBrowserRuntime(executor, ops, config.AgentProjectBrowserConfig{Enabled: true, Image: image, AllowedImages: []string{image}}); err != nil {
				t.Fatal(err)
			}
			input := ExecuteToolInput{UserID: 1, ConversationID: 3, MessageID: 5, RunID: "run", ToolCallID: "browser", ToolName: "project_browser_run", ArgumentsJSON: `{"entry":"index.html","actions":[{"type":"dom"},{"type":"screenshot"}]}`, AgentPermissions: AgentPermissions{Mode: "full", ExecuteCode: true}}
			switch scenario {
			case "manual", "auto":
				input.AgentPermissions.Mode = scenario
				service.toolApprovals = &approvalTestRepo{onCreate: func(item *repository.ToolApproval) { item.Status = "denied" }}
			case "hash错误":
				repo.files[1].SHA256 = "bad"
			case "路径穿越":
				repo.files[1].RelativePath = "../app.js"
			case "权限拒绝":
				input.AgentPermissions.ExecuteCode = false
			case "清理失败":
				executor.err = runtime.ErrCleanup
			case "容量拒绝":
				ops.lease.Token = "occupied"
			case "附件失败":
				repo.attachErr = errors.New("附件失败")
			}
			output, err := service.executeToolCallSafely(t.Context(), input)
			if scenario == "成功" {
				if err != nil || len(repo.attachment) != 1 || !strings.Contains(output, `"javascript":true`) || strings.Contains(output, `"data"`) || ops.lease.Token != "" {
					t.Fatalf("%s %v", output, err)
				}
				if _, err := service.executeToolCallSafely(t.Context(), input); err == nil || executor.calls != 1 {
					t.Fatal("重复操作未拒绝")
				}
			} else {
				if err == nil || output != "" {
					t.Fatalf("应拒绝 %s %v", output, err)
				}
				if scenario == "清理失败" && ops.lease.Token == "" {
					t.Fatal("清理失败释放容量")
				}
				if scenario != "清理失败" && scenario != "附件失败" && executor.calls != 0 {
					t.Fatal("拒绝前执行")
				}
			}
		})
	}
}
func TestProjectBrowserStrictActions(t *testing.T) {
	for _, raw := range []string{`{"entry":"../index.html","actions":[]}`, `{"entry":"index.html","actions":[{"type":"evaluate","script":"1"}]}`, `{"entry":"index.html","actions":[{"type":"press","selector":"input","key":"Control+L"}]}`, `{"entry":"index.html","actions":[],"entry":"index.html"}`, `{"entry":"index.html","actions":[{"type":"screenshot","selector":"a"}]}`} {
		if _, err := parseBrowserArguments(raw); err == nil {
			t.Fatal(raw)
		}
	}
}
func TestProjectBrowserResultValidation(t *testing.T) {
	snapshot := &projectBrowserSnapshot{Hash: "hash", Actions: []browserAction{{Type: "screenshot"}, {Type: "dom"}}}
	valid, _ := json.Marshal(map[string]any{"protocol": 1, "snapshot_hash": "hash", "completed_actions": 2, "dom": []browserDOMNode{{Text: "safe"}}, "console_errors": []string{}, "screenshot": json.RawMessage(screenshotJSON(screenshotPNG(t), "hash"))})
	if _, png, err := parseBrowserResult(valid, snapshot); err != nil || len(png) == 0 {
		t.Fatal(err)
	}
	for _, raw := range [][]byte{[]byte(strings.Replace(string(valid), `"snapshot_hash":"hash"`, `"snapshot_hash":"foreign"`, 1)), []byte(strings.Replace(string(valid), `"protocol":1`, `"unknown":true,"protocol":1`, 1)), []byte(strings.Replace(string(valid), `"completed_actions":2`, `"completed_actions":1`, 1)), []byte(`{"protocol":1,"protocol":1}`)} {
		if _, _, err := parseBrowserResult(raw, snapshot); err == nil {
			t.Fatal("接受不可信结果")
		}
	}
}

func TestProjectBrowserApprovalBindsAllFiles(t *testing.T) {
	snapshot := &projectBrowserSnapshot{Hash: "multi-file-hash"}
	s := &Service{}
	version, err := s.approvalWorkspaceVersion(t.Context(), ExecuteToolInput{ToolName: "project_browser_run", browserSnapshot: snapshot})
	if err != nil || version != snapshot.Hash {
		t.Fatal("审批未使用冻结多文件快照")
	}
}
