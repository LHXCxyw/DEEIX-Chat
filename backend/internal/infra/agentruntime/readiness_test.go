package agentruntime

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReadinessRejectsRunnerContractMismatch(t *testing.T) {
	var metadata bytes.Buffer
	if err := defaultRun([]string{"image"}, &metadata); err != nil {
		t.Fatal(err)
	}
	for _, mismatch := range []struct{ name, old, replacement string }{
		{"digest", testImage, "offline/python@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		{"root 用户", `"User":"65532:65532"`, `"User":"0:0"`},
		{"版本", `"io.deeix.agent.runner-version":"1.0.0"`, `"io.deeix.agent.runner-version":"2.0.0"`},
		{"协议", `"io.deeix.agent.protocol":"1"`, `"io.deeix.agent.protocol":"2"`},
		{"入口", `"Entrypoint":["/usr/local/bin/python3","-I","/opt/deeix/runner.py"]`, `"Entrypoint":["/bin/sh"]`},
		{"自检", `"--healthcheck"`, `"--invalid"`},
	} {
		t.Run(mismatch.name, func(t *testing.T) {
			f := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				if args[0] == "image" {
					_, _ = io.WriteString(out, strings.Replace(metadata.String(), mismatch.old, mismatch.replacement, 1))
					return nil
				}
				if args[0] != "info" {
					t.Fatal("就绪检查不应启动容器")
				}
				return defaultRun(args, out)
			}}
			if err := adapter(t, f).CheckReadiness(context.Background(), testImage); err == nil {
				t.Fatal("错误的 runner 契约未被拒绝")
			}
		})
	}
}

func TestReadinessAcceptsImageID(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("c", 64)
	var base bytes.Buffer
	if err := defaultRun([]string{"image"}, &base); err != nil {
		t.Fatal(err)
	}
	matched := strings.Replace(base.String(), `[{"Os":"linux"`, `[{"Id":"`+imageID+`","Os":"linux"`, 1)
	for _, tt := range []struct {
		name, metadata string
		ready          bool
	}{
		{"匹配", matched, true},
		{"ID 不匹配", strings.Replace(matched, imageID, "sha256:"+strings.Repeat("d", 64), 1), false},
		{"缺少 Id", base.String(), false},
		{"非法 JSON", "bad", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				if args[0] == "info" {
					return defaultRun(args, out)
				}
				if args[0] != "image" || len(args) != 3 || args[1] != "inspect" || args[2] != imageID {
					t.Fatalf("未按镜像 ID 检查: %v", args)
				}
				_, err := io.WriteString(out, tt.metadata)
				return err
			}}
			d, err := NewDocker(f, []string{imageID})
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

func TestCheckReadiness(t *testing.T) {
	for _, tt := range []struct {
		name, info, image string
		fail              bool
	}{
		{"就绪", safeInfo, `[{"Os":"linux","RepoDigests":["offline/python@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"Config":{"User":"65532:65532","Entrypoint":["/usr/local/bin/python3","-I","/opt/deeix/runner.py"],"Labels":{"io.deeix.agent.runner":"deeix-agent-command","io.deeix.agent.runner-version":"1.0.0","io.deeix.agent.protocol":"1"},"Healthcheck":{"Test":["CMD","/usr/local/bin/python3","-I","/opt/deeix/runner.py","--healthcheck"]},"Volumes":null}}]`, false},
		{"隔离不足", `{"OSType":"linux"}`, `[{"Os":"linux"}]`, true},
		{"卷绕过", safeInfo, `[{"Os":"linux","Config":{"Volumes":{"/data":{}}}}]`, true},
		{"镜像缺失", safeInfo, `[]`, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			runner := &fakeRunner{onRun: func(_ context.Context, args []string, _ io.Reader, out io.Writer) error {
				switch args[0] {
				case "info":
					_, _ = io.WriteString(out, tt.info)
				case "image":
					_, _ = io.WriteString(out, tt.image)
				default:
					return errors.New("就绪探针禁止启动或修改容器")
				}
				return nil
			}}
			err := adapter(t, runner).CheckReadiness(context.Background(), testImage)
			if (err != nil) != tt.fail {
				t.Fatalf("就绪结果错误: %v", err)
			}
		})
	}
}
