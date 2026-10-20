package agentruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

func TestCLIHelperProcess(t *testing.T) {
	separator := -1
	for i, arg := range os.Args {
		if arg == "--" {
			separator = i
			break
		}
	}
	if separator < 0 {
		return
	}
	if os.Getenv("AGENT_TEST_SECRET") != "" || os.Getenv("DOCKER_HOST") != "" || os.Getenv("AGENT_DOCKER_HOST") != "" || os.Getenv("AGENT_DOCKER_CERT_PATH") != "" {
		os.Exit(3)
	}
	rest := os.Args[separator+1:]
	for i := 0; i+1 < len(rest); i++ {
		if rest[i] == "container" && rest[i+1] == "inspect" {
			id := rest[len(rest)-1]
			if len(id) == 64 {
				_, _ = fmt.Fprintf(os.Stderr, "Error: No such object: %s", id)
				os.Exit(1)
			}
		}
	}
	_ = json.NewEncoder(os.Stdout).Encode(rest)
	os.Exit(0)
}

func resetDockerEndpointEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"AGENT_DOCKER_HOST", "AGENT_DOCKER_TLS_VERIFY", "AGENT_DOCKER_CERT_PATH", "AGENT_DOCKER_ALLOW_INSECURE_TCP"} {
		t.Setenv(key, "")
	}
}

// testCommand 将注入的 Docker 全局参数移到测试二进制 "--" 之后，避免 Go 测试框架解析未知 flag。
func testCommand(globalCount int) func(context.Context, string, ...string) *exec.Cmd {
	return func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if globalCount == 0 {
			return exec.CommandContext(ctx, name, args...)
		}
		globals := append([]string{}, args[:globalCount]...)
		rest := append([]string{}, args[globalCount:]...)
		for i, arg := range rest {
			if arg == "--" {
				rest = append(append(append([]string{}, rest[:i+1]...), globals...), rest[i+1:]...)
				break
			}
		}
		return exec.CommandContext(ctx, name, rest...)
	}
}

func TestCLIDoesNotInheritSecretsOrInvokeShell(t *testing.T) {
	t.Setenv("AGENT_TEST_SECRET", "must-not-leak")
	t.Setenv("DOCKER_HOST", "tcp://untrusted.invalid:1234")
	resetDockerEndpointEnv(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cli := &CLI{executable: executable}
	want := []string{"; echo unexpected", "$(touch /host)", "a b", "--privileged"}
	args := append([]string{"-test.run=^TestCLIHelperProcess$", "--"}, want...)
	var out bytes.Buffer
	if err := cli.Run(context.Background(), args, nil, &out); err != nil {
		t.Fatalf("子进程失败: %v %s", err, out.String())
	}
	var got []string
	if err := json.NewDecoder(&out).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv 被改写: %v", got)
	}
}

func TestCLIEndpointArguments(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	certDir := t.TempDir()
	for _, name := range []string{"ca.pem", "cert.pem", "key.pem"} {
		if err := os.WriteFile(filepath.Join(certDir, name), []byte("test"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ca := filepath.Join(certDir, "ca.pem")
	cert := filepath.Join(certDir, "cert.pem")
	key := filepath.Join(certDir, "key.pem")
	want := []string{"; echo unexpected", "--privileged"}
	for _, tt := range []struct {
		name   string
		env    map[string]string
		global []string
	}{
		{"本地默认", nil, nil},
		{"远程 unix", map[string]string{"AGENT_DOCKER_HOST": "unix:///var/run/docker.sock"}, []string{"-H", "unix:///var/run/docker.sock"}},
		{"远程 tcp TLS", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:2376", "AGENT_DOCKER_TLS_VERIFY": "true", "AGENT_DOCKER_CERT_PATH": certDir}, []string{"-H", "tcp://docker.example:2376", "--tlsverify", "--tlscacert", ca, "--tlscert", cert, "--tlskey", key}},
		{"远程 tcp 显式允许明文", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:2375", "AGENT_DOCKER_ALLOW_INSECURE_TCP": "true"}, []string{"-H", "tcp://docker.example:2375"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resetDockerEndpointEnv(t)
			t.Setenv("AGENT_TEST_SECRET", "must-not-leak")
			t.Setenv("DOCKER_HOST", "tcp://untrusted.invalid:1234")
			for name, value := range tt.env {
				t.Setenv(name, value)
			}
			cli, err := newCLI(executable)
			if err != nil {
				t.Fatal(err)
			}
			cli.command = testCommand(len(tt.global))
			args := append([]string{"-test.run=^TestCLIHelperProcess$", "--"}, want...)
			var out bytes.Buffer
			if err := cli.Run(context.Background(), args, nil, &out); err != nil {
				t.Fatalf("子进程失败: %v %s", err, out.String())
			}
			var got []string
			if err := json.NewDecoder(&out).Decode(&got); err != nil {
				t.Fatal(err)
			}
			expected := append(append([]string{}, tt.global...), want...)
			if !reflect.DeepEqual(got, expected) {
				t.Fatalf("Docker 全局参数错误: %v", got)
			}
		})
	}
}

func TestCLIRejectsUnsafeDockerEndpoints(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	emptyDir := t.TempDir()
	for _, tt := range []struct {
		name string
		env  map[string]string
	}{
		{"明文 tcp", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:2375"}},
		{"无效 TLS 开关", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:2376", "AGENT_DOCKER_TLS_VERIFY": "yes"}},
		{"无效明文开关", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:2375", "AGENT_DOCKER_ALLOW_INSECURE_TCP": "1"}},
		{"TLS 缺少证书目录", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:2376", "AGENT_DOCKER_TLS_VERIFY": "true"}},
		{"TLS 证书文件缺失", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:2376", "AGENT_DOCKER_TLS_VERIFY": "true", "AGENT_DOCKER_CERT_PATH": emptyDir}},
		{"unix 使用 TLS", map[string]string{"AGENT_DOCKER_HOST": "unix:///var/run/docker.sock", "AGENT_DOCKER_TLS_VERIFY": "true"}},
		{"不支持的协议", map[string]string{"AGENT_DOCKER_HOST": "http://docker.example:2375"}},
		{"unix 非绝对路径", map[string]string{"AGENT_DOCKER_HOST": "unix://relative.sock"}},
		{"tcp 缺少端口", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example"}},
		{"tcp 端口非法", map[string]string{"AGENT_DOCKER_HOST": "tcp://docker.example:abc"}},
		{"TLS 无主机", map[string]string{"AGENT_DOCKER_TLS_VERIFY": "true"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resetDockerEndpointEnv(t)
			for name, value := range tt.env {
				t.Setenv(name, value)
			}
			if _, err := newCLI(executable); err == nil {
				t.Fatal("未拒绝不安全的 Docker 端点配置")
			}
		})
	}
}

func TestCLIContainerAbsentWithGlobalArgs(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	resetDockerEndpointEnv(t)
	t.Setenv("AGENT_TEST_SECRET", "must-not-leak")
	t.Setenv("DOCKER_HOST", "tcp://untrusted.invalid:1234")
	id := strings.Repeat("a", 64)
	cli := &CLI{executable: executable, globalArgs: []string{"-H", "unix:///var/run/docker.sock"}}
	cli.command = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if len(args) < 3 || !reflect.DeepEqual(args[:2], cli.globalArgs) {
			t.Fatalf("未在子命令前注入全局参数: %v", args)
		}
		helperArgs := append([]string{"-test.run=^TestCLIHelperProcess$", "--"}, args[2:]...)
		return exec.CommandContext(ctx, name, helperArgs...)
	}
	var out bytes.Buffer
	err = cli.Run(context.Background(), []string{"container", "inspect", "--format", "{{json .}}", id}, nil, &out)
	if !errors.Is(err, port.ErrContainerNotFound) {
		t.Fatalf("全局参数后未识别容器不存在: %v %s", err, out.String())
	}
}
