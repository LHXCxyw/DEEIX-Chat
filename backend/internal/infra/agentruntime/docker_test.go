package agentruntime

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

const testImage = "offline/python@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const safeInfo = `{"OSType":"linux","MemoryLimit":true,"SwapLimit":true,"CpuCfsQuota":true,"CpuCfsPeriod":true,"PidsLimit":true}`

type fakeRunner struct {
	calls [][]string
	onRun func(context.Context, []string, io.Reader, io.Writer) error
}

func (f *fakeRunner) Run(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
	f.calls = append(f.calls, append([]string(nil), args...))
	if f.onRun != nil {
		return f.onRun(ctx, args, in, out)
	}
	return defaultRun(args, out)
}
func defaultRun(args []string, out io.Writer) error {
	switch args[0] {
	case "create":
		_, _ = io.WriteString(out, strings.Repeat("b", 64))
	case "info":
		_, _ = io.WriteString(out, safeInfo)
	case "image":
		_, _ = io.WriteString(out, `[{"Os":"linux","RepoDigests":["offline/python@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"Config":{"User":"65532:65532","Entrypoint":["/usr/local/bin/python3","-I","/opt/deeix/runner.py"],"Labels":{"io.deeix.agent.runner":"deeix-agent-command","io.deeix.agent.runner-version":"1.0.0","io.deeix.agent.protocol":"1"},"Healthcheck":{"Test":["CMD","/usr/local/bin/python3","-I","/opt/deeix/runner.py","--healthcheck"]},"Volumes":null}}]`)
	case "container":
		_, _ = io.WriteString(out, `{"Status":"exited","ExitCode":0}`)
	}
	return nil
}
func request() port.Request {
	return port.Request{OperationID: "op", BindContainer: func(context.Context, port.ContainerIdentity) error { return nil }, TaskID: "t", WorkspaceID: "w", Permission: port.Permission{TaskID: "t", WorkspaceID: "w", ExecuteCode: true, Network: port.NetworkNone, Workspace: port.WorkspaceEphemeral}, Image: testImage, Command: []string{"/usr/bin/python", "-c", "print('ok')"}, Stdin: []byte("input"), Limits: port.Limits{MilliCPUs: 1000, MemoryBytes: 128 << 20, PIDs: 32, WorkspaceBytes: 32 << 20, InputBytes: 1024, OutputBytes: 1024, Timeout: time.Second}}
}
func adapter(t *testing.T, f *fakeRunner) *Docker {
	t.Helper()
	d, err := NewDocker(f, []string{testImage})
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func assertCleanup(t *testing.T, f *fakeRunner, name string) {
	t.Helper()
	if strings.HasPrefix(name, "deeix-agent-") && len(f.calls) > 3 && f.calls[3][0] == "start" {
		name = strings.Repeat("b", 64)
	}
	want := [][]string{{"stop", "--time=0", name}, {"rm", "--force", "--volumes", name}}
	if len(f.calls) < 2 || !reflect.DeepEqual(f.calls[len(f.calls)-2:], want) {
		t.Fatalf("清理不符: %v", f.calls)
	}
}
func TestSecurityArgumentsAndInput(t *testing.T) {
	f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
		if args[0] == "start" {
			b, _ := io.ReadAll(in)
			if string(b) != "input" {
				t.Fatal("输入错误")
			}
			_, _ = io.WriteString(out, "ok")
		}
		return defaultRun(args, out)
	}}
	r := request()
	r.Command = append(r.Command, "; $(touch /host)", "--privileged")
	result, err := adapter(t, f).Execute(context.Background(), r)
	if err != nil || result.ExitCode != 0 || string(result.Output) != "ok" {
		t.Fatalf("结果错误: %+v %v", result, err)
	}
	args := f.calls[2]
	required := []string{"--pull=never", "--platform=linux", "--user=65532:65532", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true", "--cpus=1.000", "--memory=134217728", "--memory-swap=134217728", "--pids-limit=32", "--ipc=private", "--log-driver=none", "--restart=no", "--no-healthcheck", "--workdir=/workspace", "--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=33554432,mode=1777"}
	for _, want := range required {
		found := false
		for _, arg := range args {
			if arg == want {
				found = true
			}
		}
		if !found {
			t.Errorf("缺少 %s", want)
		}
	}
	prefix := args[:len(args)-len(r.Command)-2]
	for _, arg := range prefix {
		if strings.HasPrefix(arg, "--mount") || strings.HasPrefix(arg, "--volume") || strings.Contains(arg, "docker.sock") || arg == "--privileged" {
			t.Errorf("危险参数 %s", arg)
		}
	}
	want := append([]string{"--entrypoint", r.Command[0], testImage}, r.Command[1:]...)
	if !reflect.DeepEqual(args[len(prefix):], want) {
		t.Fatalf("argv 被修改: %v", args)
	}
	assertCleanup(t, f, result.ContainerName)
}
func TestRejectUnsafeRequest(t *testing.T) {
	cases := map[string]func(*port.Request){"授权": func(r *port.Request) { r.Permission.ExecuteCode = false }, "任务": func(r *port.Request) { r.Permission.TaskID = "x" }, "工作区": func(r *port.Request) { r.Permission.WorkspaceID = "x" }, "网络": func(r *port.Request) { r.Permission.Network = "host" }, "持久卷": func(r *port.Request) { r.Permission.Workspace = "persistent" }, "镜像": func(r *port.Request) { r.Image = "python:latest" }, "CPU": func(r *port.Request) { r.Limits.MilliCPUs = 2001 }, "内存": func(r *port.Request) { r.Limits.MemoryBytes = 0 }, "PID": func(r *port.Request) { r.Limits.PIDs = -1 }, "磁盘": func(r *port.Request) { r.Limits.WorkspaceBytes = 2 << 30 }, "内存不足": func(r *port.Request) { r.Limits.WorkspaceBytes = 256 << 20 }, "超时": func(r *port.Request) { r.Limits.Timeout = 121 * time.Second }, "输入": func(r *port.Request) { r.Limits.InputBytes = 1 }, "输出": func(r *port.Request) { r.Limits.OutputBytes = 0 }, "相对路径": func(r *port.Request) { r.Command[0] = "python" }, "空命令": func(r *port.Request) { r.Command = nil }, "NUL": func(r *port.Request) { r.Command = append(r.Command, "\x00") }, "过大命令": func(r *port.Request) { r.Command = append(r.Command, strings.Repeat("a", 65<<10)) }}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := &fakeRunner{}
			r := request()
			change(&r)
			_, err := adapter(t, f).Execute(context.Background(), r)
			if !errors.Is(err, port.ErrDenied) && !errors.Is(err, port.ErrInvalid) {
				t.Fatalf("未拒绝: %v", err)
			}
			if len(f.calls) != 0 {
				t.Fatal("拒绝前调用 Docker")
			}
		})
	}
}
func TestRejectImageVolumesOrOS(t *testing.T) {
	for _, metadata := range []string{`[{"Os":"linux","Config":{"Volumes":{"/data":{}}}}]`, `[{"Os":"windows","Config":{}}]`, `[]`, `bad`} {
		f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
			if args[0] == "image" {
				_, _ = io.WriteString(out, metadata)
				return nil
			}
			return defaultRun(args, out)
		}}
		_, err := adapter(t, f).Execute(context.Background(), request())
		if !errors.Is(err, port.ErrDenied) || len(f.calls) != 2 {
			t.Fatalf("未拒绝: %v %v", err, f.calls)
		}
	}
}
func TestRejectUnsupportedCapabilities(t *testing.T) {
	for _, info := range []string{`{}`, `bad`, strings.Replace(safeInfo, `"PidsLimit":true`, `"PidsLimit":false`, 1), strings.Replace(safeInfo, `"SwapLimit":true`, `"SwapLimit":false`, 1), strings.Replace(safeInfo, `"MemoryLimit":true`, `"MemoryLimit":false`, 1), strings.Replace(safeInfo, `"CpuCfsQuota":true`, `"CpuCfsQuota":false`, 1), strings.Replace(safeInfo, `"CpuCfsPeriod":true`, `"CpuCfsPeriod":false`, 1), strings.Replace(safeInfo, `"OSType":"linux"`, `"OSType":"windows"`, 1), strings.TrimSuffix(safeInfo, "}") + `,"Warnings":["unsupported"]}`} {
		f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
			_, _ = io.WriteString(out, info)
			return nil
		}}
		_, err := adapter(t, f).Execute(context.Background(), request())
		if !errors.Is(err, port.ErrUnavailable) || len(f.calls) != 1 {
			t.Fatalf("未关闭失败路径: %v", err)
		}
	}
}
func TestCancellationTimeoutCleanup(t *testing.T) {
	for _, stage := range []string{"create", "start", "timeout"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
				if args[0] == stage || stage == "timeout" && args[0] == "start" {
					if stage != "timeout" {
						cancel()
					}
					<-ctx.Done()
					return ctx.Err()
				}
				if args[0] == "stop" || args[0] == "rm" {
					if ctx.Err() != nil {
						t.Fatal("清理继承取消")
					}
					if _, ok := ctx.Deadline(); !ok {
						t.Fatal("清理无超时")
					}
				}
				return defaultRun(args, out)
			}}
			r := request()
			if stage == "timeout" {
				r.Limits.Timeout = 20 * time.Millisecond
			}
			result, err := adapter(t, f).Execute(ctx, r)
			want := context.Canceled
			if stage == "timeout" {
				want = context.DeadlineExceeded
			}
			if !errors.Is(err, want) {
				t.Fatalf("错误: %v", err)
			}
			assertCleanup(t, f, result.ContainerName)
		})
	}
}
func TestOutputLimit(t *testing.T) {
	f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
		if args[0] == "start" {
			for i := 0; i < 10; i++ {
				_, _ = io.WriteString(out, "abcd")
			}
			if ctx.Err() == nil {
				t.Fatal("未取消实际执行")
			}
			return ctx.Err()
		}
		return defaultRun(args, out)
	}}
	r := request()
	r.Limits.OutputBytes = 5
	result, err := adapter(t, f).Execute(context.Background(), r)
	if !errors.Is(err, port.ErrOutputLimit) || string(result.Output) != "abcda" {
		t.Fatalf("输出未受限: %+v %v", result, err)
	}
	assertCleanup(t, f, result.ContainerName)
}
func TestCreateFailureCleanupFailure(t *testing.T) {
	for _, failRemove := range []bool{false, true} {
		f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
			if args[0] == "create" || args[0] == "stop" || failRemove && args[0] == "rm" {
				return errors.New("fake failure")
			}
			return defaultRun(args, out)
		}}
		result, err := adapter(t, f).Execute(context.Background(), request())
		if !errors.Is(err, port.ErrUnavailable) || errors.Is(err, port.ErrCleanup) != failRemove {
			t.Fatalf("错误: %v", err)
		}
		assertCleanup(t, f, result.ContainerName)
	}
}
func TestExitCodeAndUnknownExit(t *testing.T) {
	for _, running := range []bool{false, true} {
		f := &fakeRunner{onRun: func(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
			if args[0] == "start" {
				return errors.New("exit 7")
			}
			if args[0] == "container" {
				state := `{"Status":"exited","ExitCode":7}`
				if running {
					state = `{"Status":"running","Running":true}`
				}
				_, _ = io.WriteString(out, state)
				return nil
			}
			return defaultRun(args, out)
		}}
		result, err := adapter(t, f).Execute(context.Background(), request())
		if running {
			if !errors.Is(err, port.ErrUnavailable) {
				t.Fatal("接受未确认退出")
			}
		} else if err != nil || result.ExitCode != 7 {
			t.Fatalf("退出码错误: %+v %v", result, err)
		}
		assertCleanup(t, f, result.ContainerName)
	}
}
func TestDigestAllowlist(t *testing.T) {
	for _, images := range [][]string{nil, {"python:latest"}, {"--privileged"}} {
		if _, err := NewDocker(&fakeRunner{}, images); !errors.Is(err, port.ErrInvalid) {
			t.Fatal("接受无效镜像")
		}
	}
	if _, err := NewDocker(nil, []string{testImage}); !errors.Is(err, port.ErrInvalid) {
		t.Fatal("接受空 runner")
	}
}
