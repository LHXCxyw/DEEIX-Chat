package conversation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
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

func screenshotPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 1280, 720))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func screenshotJSON(data []byte, hash string) []byte {
	raw, _ := json.Marshal(map[string]any{"protocol": 1, "snapshot_hash": hash, "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(data)})
	return raw
}
func TestScreenshotStrictProtocol(t *testing.T) {
	valid := screenshotJSON(screenshotPNG(t), "hash")
	for _, tc := range []struct {
		name string
		data []byte
		hash string
		bad  bool
	}{
		{"有效", valid, "hash", false},
		{"哈希", valid, "other", true},
		{"尾随", append(append([]byte{}, valid...), []byte(` {}`)...), "hash", true},
		{"重复键", []byte(`{"protocol":1,"protocol":1}`), "hash", true},
		{"未知字段", []byte(strings.Replace(string(valid), `"protocol":1`, `"extra":1,"protocol":1`, 1)), "hash", true},
		{"损坏PNG", screenshotJSON([]byte("not png"), "hash"), "hash", true},
		{"超限", bytes.Repeat([]byte("x"), (6<<20)+1), "hash", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseScreenshotResult(tc.data, tc.hash)
			if (err != nil) != tc.bad {
				t.Fatal(err)
			}
		})
	}
}

type screenshotExecutor struct {
	calls int
	repo  *commandOperationRepo
	png   []byte
	err   error
}

func (*screenshotExecutor) CheckReadiness(context.Context, string) error { return nil }
func (e *screenshotExecutor) Execute(ctx context.Context, r runtime.Request) (runtime.Result, error) {
	e.calls++
	if e.repo.item.Status != operation.Running || r.Permission.Network != runtime.NetworkNone || strings.Join(r.Command, " ") != "/usr/local/bin/node /app/src/offline-cli.js" {
		panic("截图必须受控执行")
	}
	if err := r.BindContainer(ctx, runtime.ContainerIdentity{ID: strings.Repeat("b", 64), Owner: strings.Repeat("a", 64), TaskID: r.TaskID, OperationID: r.OperationID}); err != nil {
		return runtime.Result{}, err
	}
	return runtime.Result{ExitCode: 0, Output: screenshotJSON(e.png, commandHash(r.Stdin))}, e.err
}

func TestScreenshotApprovalModes(t *testing.T) {
	for _, mode := range []string{"manual", "auto", "full"} {
		t.Run(mode, func(t *testing.T) {
			service, _ := newProjectVersionTestService(t, "html")
			approvals := &approvalTestRepo{onCreate: func(item *repository.ToolApproval) { item.Status = "denied" }}
			service.toolApprovals = approvals
			input := ExecuteToolInput{UserID: 1, ConversationID: 3, RunID: "run", ToolCallID: "shot", ToolName: "project_render_screenshot", ArgumentsJSON: `{"path":"index.html"}`, AgentPermissions: AgentPermissions{Mode: mode, ExecuteCode: true}}
			err := service.approveToolExecution(t.Context(), input)
			if mode == "full" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || approvals.item.ToolName != "project_render_screenshot" {
				t.Fatal("截图绕过统一审批")
			}
		})
	}
}

func TestScreenshotDeliveryAndRejection(t *testing.T) {
	for _, scenario := range []string{"成功", "路径穿越", "非HTML", "hash错误", "其他run", "权限拒绝", "清理失败", "超量准入", "无上传", "附件失败"} {
		t.Run(scenario, func(t *testing.T) {
			html := "<h1>固定快照</h1>"
			repo := &deliveryRepo{ordinary: true, message: model.Message{ID: 5, UserID: 1, Role: "assistant", RunID: "run", Status: "pending"}, files: []model.ProjectFile{{EntryType: "file", RelativePath: "index.html", StorageKey: "html", SHA256: commandHash([]byte(html))}}}
			store := &deliveryStore{archiveDeliveryStore{data: map[string]string{"html": html}}}
			cfg := config.NewRuntime(config.Config{MaxUploadFileBytes: 4 << 20, FileAllowedMIMETypes: "image/png"})
			provider := appstorage.NewRuntimeProvider(cfg, func(context.Context, config.Config) (objectstorage.Store, error) { return store, nil })
			upload := appupload.NewServiceWithRuntime(cfg, repo, nil, appupload.Hooks{}, appupload.ErrorSet{FileNotFound: ErrFileNotFound}, "")
			upload.SetObjectStoreProvider(provider)
			service := &Service{repo: repo, uploadSvc: upload, storeProvider: provider}
			ops := &commandOperationRepo{}
			executor := &screenshotExecutor{repo: ops, png: screenshotPNG(t)}
			image := "local/offline@sha256:" + strings.Repeat("c", 64)
			if err := service.SetScreenshotRuntime(executor, ops, config.AgentScreenshotConfig{Enabled: true, Image: image, AllowedImages: []string{image}}); err != nil {
				t.Fatal(err)
			}
			input := ExecuteToolInput{UserID: 1, ConversationID: 3, MessageID: 5, RunID: "run", ToolCallID: "shot", ToolName: "project_render_screenshot", ArgumentsJSON: `{"path":"index.html"}`, AgentPermissions: AgentPermissions{Mode: "full", ExecuteCode: true}}
			switch scenario {
			case "路径穿越":
				input.ArgumentsJSON = `{"path":"../index.html"}`
			case "非HTML":
				input.ArgumentsJSON = `{"path":"a.svg"}`
			case "hash错误":
				repo.files[0].SHA256 = "bad"
			case "其他run":
				repo.message.RunID = "foreign"
			case "权限拒绝":
				input.AgentPermissions.ExecuteCode = false
			case "清理失败":
				executor.err = runtime.ErrCleanup
			case "超量准入":
				ops.lease.Token = "occupied"
			case "无上传":
				service.uploadSvc = nil
			case "附件失败":
				repo.attachErr = errors.New("附件失败")
			}
			output, err := service.executeToolCallSafely(context.Background(), input)
			if scenario == "成功" {
				if err != nil || !strings.Contains(output, `"download_ui":true`) || strings.Contains(output, `"data"`) || len(repo.attachment) != 1 || repo.attachment[0].MessageID != 5 || repo.attachment[0].Kind != "image" || ops.lease.Token != "" {
					t.Fatalf("%s %v %#v", output, err, repo.attachment)
				}
				if _, err := service.executeToolCallSafely(context.Background(), input); err == nil || executor.calls != 1 {
					t.Fatal("重复执行未拒绝")
				}
			} else {
				if err == nil || output != "" {
					t.Fatalf("应拒绝: %s %v", output, err)
				}
				if scenario == "清理失败" && ops.lease.Token == "" {
					t.Fatal("清理失败不得释放容量")
				}
				if scenario != "附件失败" && scenario != "清理失败" && executor.calls != 0 {
					t.Fatal("拒绝前发生执行")
				}
			}
		})
	}
}
