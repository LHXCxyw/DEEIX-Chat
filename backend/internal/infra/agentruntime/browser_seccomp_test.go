package agentruntime

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func newBrowserProbe() func([]string, io.Writer) error {
	labels := map[string]string{}
	return func(args []string, out io.Writer) error {
		if args[0] == "create" {
			for _, arg := range args {
				if strings.HasPrefix(arg, "--label=") {
					parts := strings.SplitN(strings.TrimPrefix(arg, "--label="), "=", 2)
					labels[parts[0]] = parts[1]
				}
			}
		}
		if args[0] == "container" && len(args) == 3 {
			data, _ := json.Marshal([]any{map[string]any{
				"Config": map[string]any{"User": "65532:65532", "Labels": labels},
				"HostConfig": map[string]any{"NetworkMode": "none", "ReadonlyRootfs": true, "CapDrop": []string{"ALL"}, "CapAdd": []string{"SYS_CHROOT"}, "SecurityOpt": []string{"no-new-privileges=true", "seccomp=" + string(browserSeccomp)}},
			}})
			_, err := out.Write(data)
			return err
		}
		return defaultRun(args, out)
	}
}

func TestBrowserRuntimeReadinessFailsClosed(t *testing.T) {
	for _, offline := range []bool{false, true} {
		for _, fail := range []bool{false, true} {
			probe := newBrowserProbe()
			f := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				if args[0] == "container" && len(args) == 5 && fail {
					_, err := io.WriteString(out, `{"Status":"exited","ExitCode":1}`)
					return err
				}
				return probe(args, out)
			}}
			d := adapter(t, f)
			d.browserPolicy = true
			script := "/app/src/project-browser-cli.js"
			if offline { script = "/app/src/offline-cli.js" }
			if err := d.checkBrowserRuntime(context.Background(), testImage, script); (err != nil) != fail {
				t.Fatalf("fail=%v err=%v", fail, err)
			}
			assertCleanup(t, f, strings.Repeat("b", 64))
		}
	}
}

func TestBrowserSeccompArguments(t *testing.T) {
	for _, offline := range []bool{false, true} {
		r := request()
		var d *Docker
		if offline {
			adapter, err := NewOfflineScreenshot(&fakeRunner{}, []string{testImage})
			if err != nil {
				t.Fatal(err)
			}
			d = adapter.Docker
			r.Command = []string{"/usr/local/bin/node", "/app/src/offline-cli.js"}
		} else {
			adapter, err := NewProjectBrowser(&fakeRunner{}, []string{testImage})
			if err != nil {
				t.Fatal(err)
			}
			d = adapter.Docker
			r.Command = []string{"/usr/local/bin/node", "/app/src/project-browser-cli.js"}
		}
		args := d.createArgs(r, "probe")
		if !contains(args, "--security-opt=seccomp="+browserSeccompPath) {
			t.Fatalf("浏览器缺少 namespace syscall 策略: %v", args)
		}
		for _, required := range []string{"--cap-add=SYS_CHROOT", "--label=com.deeix.agent.seccomp=" + browserSeccompPolicy, "--cap-drop=ALL", "--security-opt=no-new-privileges=true", "--network=none", "--read-only", "--user=65532:65532"} {
			if !contains(args, required) {
				t.Fatal(required)
			}
		}
	}
	d := adapter(t, &fakeRunner{})
	for _, arg := range d.createArgs(request(), "command") {
		if strings.Contains(arg, "seccomp=") || strings.HasPrefix(arg, "--cap-add") {
			t.Fatal("command 策略被放宽")
		}
	}
}

func TestBrowserInspectSeccompRejectsPolicyDrift(t *testing.T) {
	var policy map[string]any
	if err := json.Unmarshal(browserSeccomp, &policy); err != nil {
		t.Fatal(err)
	}
	policy["defaultAction"] = "SCMP_ACT_ALLOW"
	altered, _ := json.Marshal(policy)
	for _, options := range [][]string{
		{"no-new-privileges=true"},
		{"no-new-privileges=true", "seccomp=unconfined"},
		{"no-new-privileges=true", "seccomp=" + string(altered)},
		{"no-new-privileges=true", "seccomp=" + string(browserSeccomp), "apparmor=unconfined"},
	} {
		if browserSecurityOptions(options) {
			t.Fatal("inspect 接受非受控策略")
		}
	}
	if !browserSecurityOptions([]string{"no-new-privileges=true", "seccomp=" + string(browserSeccomp)}) {
		t.Fatal("拒绝受控策略")
	}
}
