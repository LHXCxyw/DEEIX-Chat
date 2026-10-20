package agentruntime

import (
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"time"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

const browserSeccompPath = "/opt/deeix/browser-seccomp.json"
const browserSeccompPolicy = "moby-27.5.1-chromium-userns-v2"

//go:embed browser-seccomp.json
var browserSeccomp []byte

// Docker CLI 读取本地文件并将 JSON 传给 daemon；文件必须在 app/seed 内，而不是任务内。
func checkBrowserSeccompFile() error {
	data, err := os.ReadFile(browserSeccompPath)
	if err != nil || !bytes.Equal(data, browserSeccomp) {
		return port.ErrUnavailable
	}
	return nil
}

func browserSecurityOptions(options []string) bool {
	if len(options) != 2 || !contains(options, "no-new-privileges=true") {
		return false
	}
	var expected any
	if json.Unmarshal(browserSeccomp, &expected) != nil {
		return false
	}
	for _, option := range options {
		if strings.HasPrefix(option, "seccomp=") {
			var actual any
			return json.Unmarshal([]byte(strings.TrimPrefix(option, "seccomp=")), &actual) == nil && reflect.DeepEqual(actual, expected)
		}
	}
	return false
}

func (d *Docker) checkBrowserRuntime(ctx context.Context, image, script string) error {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return port.ErrUnavailable
	}
	id := "selftest-" + hex.EncodeToString(token[:])
	r := port.Request{
		TaskID: id, WorkspaceID: id, OperationID: id,
		BindContainer: func(context.Context, port.ContainerIdentity) error { return nil },
		Permission:    port.Permission{TaskID: id, WorkspaceID: id, ExecuteCode: true, Network: port.NetworkNone, Workspace: port.WorkspaceEphemeral},
		Image:         image, Command: []string{"/usr/local/bin/node", script, "--selftest"},
		Limits: port.Limits{MilliCPUs: 2000, MemoryBytes: 1 << 30, PIDs: 128, WorkspaceBytes: 256 << 20, InputBytes: 1, OutputBytes: 64 << 10, Timeout: 60 * time.Second},
	}
	result, err := d.Execute(ctx, r)
	if err != nil || result.ExitCode != 0 {
		return port.ErrUnavailable
	}
	// 固定可信入口仅在 capability、真实 Chromium sandbox 和渲染均通过后以 0 退出。
	return nil
}

func (d *Docker) createArgs(r port.Request, name string) []string {
	args := createArgs(r, name)
	if d.browserPolicy {
		args = append(args[:1], append([]string{"--cap-add=SYS_CHROOT", "--security-opt=seccomp=" + browserSeccompPath, "--label=com.deeix.agent.seccomp=" + browserSeccompPolicy}, args[1:]...)...)
	}
	return args
}
