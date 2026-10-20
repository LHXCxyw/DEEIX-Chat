package agentruntime

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

func TestOfflineScreenshotReadinessSeparation(t *testing.T) {
	for _, scenario := range []string{"成功", "命令镜像", "root", "卷", "入口", "digest", "镜像ID"} {
		t.Run(scenario, func(t *testing.T) {
			config := map[string]any{"User": "65532:65532", "Entrypoint": []string{"/usr/local/bin/node", "/app/src/offline-cli.js"}, "Labels": map[string]string{"io.deeix.agent.sandbox-policy": browserSeccompPolicy, "io.deeix.agent.runner": "deeix-agent-offline-screenshot", "io.deeix.agent.runner-version": "1.0.0", "io.deeix.agent.protocol": "1"}, "Healthcheck": map[string]any{"Test": []string{"CMD", "/usr/local/bin/node", "/app/src/offline-cli.js", "--selftest"}}}
			digest := testImage
			switch scenario {
			case "命令镜像":
				config["Labels"].(map[string]string)["io.deeix.agent.runner"] = "deeix-agent-command"
			case "root":
				config["User"] = "0:0"
			case "卷":
				config["Volumes"] = map[string]any{"/data": map[string]any{}}
			case "入口":
				config["Entrypoint"] = []string{"/bin/sh"}
			case "digest":
				digest = "wrong"
			}
			raw, _ := json.Marshal([]any{map[string]any{"Os": "linux", "RepoDigests": []string{digest}, "Config": config}})
			image := testImage
			if scenario == "镜像ID" {
				image = "sha256:" + strings.Repeat("a", 64)
				raw, _ = json.Marshal([]any{map[string]any{"Id": image, "Os": "linux", "RepoDigests": []string{}, "Config": config}})
			}
			probe := newBrowserProbe()
			f := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				if args[0] == "image" {
					_, err := out.Write(raw)
					return err
				}
				return probe(args, out)
			}}
			d, err := NewOfflineScreenshot(f, []string{image})
			if err != nil {
				t.Fatal(err)
			}
			err = d.CheckReadiness(context.Background(), image)
			if (err == nil) != (scenario == "成功" || scenario == "镜像ID") {
				t.Fatal(err)
			}
			if err := d.Docker.CheckReadiness(context.Background(), testImage); err == nil {
				t.Fatal("浏览器不能作为命令 runner")
			}
			if _, err := d.Execute(context.Background(), port.Request{Command: []string{"/bin/sh"}}); err == nil {
				t.Fatal("禁止控制入口")
			}
		})
	}
}
