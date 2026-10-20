package agentruntime

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

func browserImageMetadata(runner string) []byte {
	raw, _ := json.Marshal([]any{map[string]any{"Os": "linux", "RepoDigests": []string{testImage}, "Config": map[string]any{"User": "65532:65532", "Entrypoint": []string{"/usr/local/bin/node", "/app/src/project-browser-cli.js"}, "Labels": map[string]string{"io.deeix.agent.sandbox-policy": browserSeccompPolicy, "io.deeix.agent.runner": runner, "io.deeix.agent.runner-version": "1.0.0", "io.deeix.agent.protocol": "1"}, "Healthcheck": map[string]any{"Test": []string{"CMD", "/usr/local/bin/node", "/app/src/project-browser-cli.js", "--selftest"}}}}})
	return raw
}
func TestProjectBrowserImageSeparation(t *testing.T) {
	for _, runner := range []string{"deeix-agent-project-browser", "deeix-agent-offline-screenshot", "deeix-agent-command"} {
		t.Run(runner, func(t *testing.T) {
			probe := newBrowserProbe()
			f := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				if args[0] == "image" {
					_, err := out.Write(browserImageMetadata(runner))
					return err
				}
				return probe(args, out)
			}}
			d, err := NewProjectBrowser(f, []string{testImage})
			if err != nil {
				t.Fatal(err)
			}
			if err := d.CheckReadiness(t.Context(), testImage); (err == nil) != (runner == "deeix-agent-project-browser") {
				t.Fatal(err)
			}
			if _, err := d.Execute(t.Context(), port.Request{Command: []string{"/bin/sh"}}); err == nil {
				t.Fatal("允许任意入口")
			}
		})
	}
}
func TestProjectBrowserReadinessAcceptsImageID(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("a", 64)
	metadata := func(id string) []byte {
		config := map[string]any{"User": "65532:65532", "Entrypoint": []string{"/usr/local/bin/node", "/app/src/project-browser-cli.js"}, "Labels": map[string]string{"io.deeix.agent.sandbox-policy": browserSeccompPolicy, "io.deeix.agent.runner": "deeix-agent-project-browser", "io.deeix.agent.runner-version": "1.0.0", "io.deeix.agent.protocol": "1"}, "Healthcheck": map[string]any{"Test": []string{"CMD", "/usr/local/bin/node", "/app/src/project-browser-cli.js", "--selftest"}}}
		raw, _ := json.Marshal([]any{map[string]any{"Id": id, "Os": "linux", "RepoDigests": []string{}, "Config": config}})
		return raw
	}
	for _, tt := range []struct {
		name, id string
		ready    bool
	}{
		{"匹配", imageID, true},
		{"ID 不匹配", "sha256:" + strings.Repeat("b", 64), false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			probe := newBrowserProbe()
			f := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				if args[0] == "image" {
					_, err := out.Write(metadata(tt.id))
					return err
				}
				return probe(args, out)
			}}
			d, err := NewProjectBrowser(f, []string{imageID})
			if err != nil {
				t.Fatal(err)
			}
			err = d.CheckReadiness(context.Background(), imageID)
			if (err == nil) != tt.ready {
				t.Fatalf("镜像 ID 就绪结果错误: %v", err)
			}
		})
	}
}

func TestProjectBrowserInspectBeforeStart(t *testing.T) {
	for _, scenario := range []string{"成功", "network", "mount", "readonly", "owner", "inspect", "unconfined", "missing-seccomp", "cap-add", "missing-cap", "extra-cap", "old-policy"} {
		t.Run(scenario, func(t *testing.T) {
			var owner, operation string
			started := false
			bound := false
			f := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				if args[0] == "image" {
					_, err := out.Write(browserImageMetadata("deeix-agent-project-browser"))
					return err
				}
				if args[0] == "create" {
					for _, arg := range args {
						if strings.HasPrefix(arg, "--label=com.deeix.agent.operation=") {
							operation = strings.TrimPrefix(arg, "--label=com.deeix.agent.operation=")
						}
						if strings.HasPrefix(arg, "--label=com.deeix.agent.owner=") {
							owner = strings.TrimPrefix(arg, "--label=com.deeix.agent.owner=")
						}
					}
				}
				if args[0] == "container" && len(args) == 3 {
					if !bound && !strings.HasPrefix(operation, "selftest-") {
						t.Fatal("inspect 前未绑定容量槽")
					}
					network := "none"
					readonly := true
					mounts := []any{map[string]any{"Type": "tmpfs", "Destination": "/workspace"}}
					if scenario == "network" {
						network = "bridge"
					}
					if scenario == "readonly" {
						readonly = false
					}
					if scenario == "mount" {
						mounts = append(mounts, map[string]any{"Type": "bind", "Destination": "/host"})
					}
					if scenario == "owner" {
						owner = "foreign"
					}
					security := []string{"no-new-privileges=true", "seccomp=" + string(browserSeccomp)}
					capAdd := []string{"SYS_CHROOT"}
					policy := browserSeccompPolicy
					if scenario == "missing-cap" {
						capAdd = nil
					}
					if scenario == "extra-cap" {
						capAdd = append(capAdd, "SYS_ADMIN")
					}
					if scenario == "old-policy" {
						policy = "moby-27.5.1-chromium-userns-v1"
					}
					if scenario == "unconfined" {
						security[1] = "seccomp=unconfined"
					}
					if scenario == "missing-seccomp" {
						security = security[:1]
					}
					if scenario == "cap-add" {
						capAdd = []string{"SYS_ADMIN"}
					}
					data, _ := json.Marshal([]any{map[string]any{"Config": map[string]any{"User": "65532:65532", "Labels": map[string]string{"com.deeix.agent.owner": owner, "com.deeix.agent.operation": operation, "com.deeix.agent.seccomp": policy}}, "HostConfig": map[string]any{"NetworkMode": network, "ReadonlyRootfs": readonly, "Privileged": false, "Binds": []string{}, "CapDrop": []string{"ALL"}, "CapAdd": capAdd, "SecurityOpt": security}, "Mounts": mounts, "NetworkSettings": map[string]any{"Networks": map[string]any{"none": map[string]any{}}}}})
					if scenario == "inspect" {
						data = []byte("invalid")
					}
					_, err := out.Write(data)
					return err
				}
				if args[0] == "start" {
					started = true
				}
				return defaultRun(args, out)
			}}
			d, err := NewProjectBrowser(f, []string{testImage})
			if err != nil {
				t.Fatal(err)
			}
			r := request()
			r.Command = []string{"/usr/local/bin/node", "/app/src/project-browser-cli.js"}
			r.BindContainer = func(context.Context, port.ContainerIdentity) error { bound = true; return nil }
			_, err = d.Execute(t.Context(), r)
			if (err == nil) != (scenario == "成功") || started != (scenario == "成功") {
				t.Fatalf("started=%v err=%v", started, err)
			}
			assertCleanup(t, f, strings.Repeat("b", 64))
		})
	}
}
