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

func TestManagedLabelsAndLocalOrphanRetry(t *testing.T) {
	fail := true
	var d *Docker
	req := request()
	req.OperationID = "command-ref"
	id := strings.Repeat("a", 64)
	labels := map[string]string{}
	f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
		if args[0] == "rm" && fail {
			return errors.New("回收失败")
		}
		if args[0] == "container" && len(args) > 3 && args[3] == "{{json .}}" {
			return json.NewEncoder(out).Encode(map[string]any{"Id": id, "Config": map[string]any{"Labels": labels}})
		}
		return defaultRun(args, out)
	}}
	d = adapter(t, f)
	_, err := d.Execute(context.Background(), req)
	if !errors.Is(err, port.ErrCleanup) {
		t.Fatalf("未暴露回收失败: %v", err)
	}
	create := strings.Join(f.calls[2], " ")
	labels = map[string]string{"com.deeix.agent.managed": "v1", "com.deeix.agent.owner": d.owner, "com.deeix.agent.task": req.TaskID, "com.deeix.agent.operation": req.OperationID}
	for key, value := range labels {
		if !strings.Contains(create, "--label="+key+"="+value) {
			t.Fatalf("缺少管理标签 %s", key)
		}
	}
	before := len(f.calls)
	empty := adapter(t, f)
	if err := empty.ReconcileOrphans(); err != nil || len(f.calls) != before {
		t.Fatal("新实例不应扫描或回收其他容器")
	}
	fail = false
	for _, key := range []string{"com.deeix.agent.managed", "com.deeix.agent.owner", "com.deeix.agent.task", "com.deeix.agent.operation"} {
		original := labels[key]
		labels[key] = "other"
		before = len(f.calls)
		if err := d.ReconcileOrphans(); !errors.Is(err, port.ErrDenied) {
			t.Fatalf("未拒绝错误身份 %s: %v", key, err)
		}
		if len(f.calls) != before+1 {
			t.Fatal("身份不符仍执行删除")
		}
		labels[key] = original
	}
	if err := d.ReconcileOrphans(); err != nil {
		t.Fatal(err)
	}
	assertCleanup(t, f, id)
	before = len(f.calls)
	if err := d.ReconcileOrphans(); err != nil || len(f.calls) != before {
		t.Fatal("重复回收已删除容器")
	}
}
