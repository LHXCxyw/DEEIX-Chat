package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"io"
	"strings"
	"testing"
)

func TestContainerAbsentClassification(t *testing.T) {
	id := strings.Repeat("a", 64)
	for _, message := range []string{"Error response from daemon: No such container: " + id, "Error: No such object: " + id} {
		if !containerAbsentMessage(message, id) {
			t.Fatal("精确不存在未识别")
		}
	}
	for _, message := range []string{"Cannot connect to the Docker daemon", "permission denied", "No such container", "Error: No such object: " + strings.Repeat("b", 64), "Error: No such object: " + id + "\npermission denied"} {
		if containerAbsentMessage(message, id) {
			t.Fatal("错误被当作不存在")
		}
	}
}

func TestBindBeforeStartFailClosed(t *testing.T) {
	for _, fail := range []bool{false, true} {
		f := &fakeRunner{}
		d := adapter(t, f)
		r := request()
		bound := false
		sentinel := errors.New("数据库不可用")
		r.BindContainer = func(_ context.Context, id port.ContainerIdentity) error {
			if f.calls[len(f.calls)-1][0] != "create" || id.ID != strings.Repeat("b", 64) || id.Owner != d.owner || id.TaskID != r.TaskID || id.OperationID != r.OperationID {
				t.Fatal("绑定身份或顺序错误")
			}
			bound = true
			if fail {
				return sentinel
			}
			return nil
		}
		f.onRun = func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
			if args[0] == "start" && (!bound || fail || args[3] != strings.Repeat("b", 64)) {
				t.Fatal("未成功绑定即启动")
			}
			return defaultRun(args, out)
		}
		_, err := d.Execute(context.Background(), r)
		if fail && !errors.Is(err, sentinel) || !fail && err != nil {
			t.Fatalf("绑定结果错误 %v", err)
		}
		if !bound {
			t.Fatal("缺少绑定")
		}
		for _, call := range f.calls {
			if fail && call[0] == "start" {
				t.Fatal("失败仍启动")
			}
		}
		last := f.calls[len(f.calls)-1]
		if last[0] != "rm" || last[3] != strings.Repeat("b", 64) {
			t.Fatal("未按ID清理")
		}
	}
}
func TestRecoveryIdentityAndAbsence(t *testing.T) {
	binding := port.ContainerIdentity{ID: strings.Repeat("b", 64), Owner: strings.Repeat("a", 64), TaskID: "actual-run", OperationID: "command-op"}
	for _, scenario := range []string{"success", "absent", "daemon_error", "running", "wrong_owner", "wrong_task", "wrong_operation", "wrong_managed", "wrong_id", "remove_failure", "still_exists", "inspect_failure"} {
		t.Run(scenario, func(t *testing.T) {
			removed := false
			f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
				if args[0] == "container" {
					if args[4] != binding.ID {
						t.Fatal("使用非持久ID")
					}
					if scenario == "absent" || removed && scenario != "still_exists" && scenario != "inspect_failure" {
						return port.ErrContainerNotFound
					}
					if scenario == "daemon_error" || removed && scenario == "inspect_failure" {
						return errors.New("daemon unavailable")
					}
					labels := map[string]string{"com.deeix.agent.managed": "v1", "com.deeix.agent.owner": binding.Owner, "com.deeix.agent.task": binding.TaskID, "com.deeix.agent.operation": binding.OperationID}
					for _, key := range []string{"owner", "task", "operation", "managed"} {
						if scenario == "wrong_"+key {
							labels["com.deeix.agent."+key] = "other"
						}
					}
					id := binding.ID
					if scenario == "wrong_id" {
						id = strings.Repeat("c", 64)
					}
					return json.NewEncoder(out).Encode(map[string]any{"Id": id, "Config": map[string]any{"Labels": labels}, "State": map[string]any{"Running": scenario == "running", "Status": "exited"}})
				}
				if args[0] == "rm" {
					if scenario == "remove_failure" {
						return errors.New("rm failed")
					}
					removed = true
				}
				return nil
			}}
			err := adapter(t, f).RecoverContainer(context.Background(), binding)
			success := scenario == "success" || scenario == "absent"
			if (err == nil) != success {
				t.Fatalf("结果不符 %v", err)
			}
			if !success && scenario != "remove_failure" && scenario != "still_exists" && scenario != "inspect_failure" && len(f.calls) != 1 {
				t.Fatal("拒绝前已清理")
			}
		})
	}
}
