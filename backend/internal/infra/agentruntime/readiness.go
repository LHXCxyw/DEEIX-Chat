package agentruntime

import (
	"context"
	"encoding/json"
	"strings"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

const (
	runnerName     = "deeix-agent-command"
	runnerVersion  = "1.0.0"
	runnerProtocol = "1"
	runnerPython   = "/usr/local/bin/python3"
	runnerScript   = "/opt/deeix/runner.py"
)

// CheckReadiness 只检查真实守护进程约束与本地镜像，不启动容器或拉取镜像。
func (d *Docker) CheckReadiness(ctx context.Context, image string) error {
	if !d.images[image] {
		return port.ErrDenied
	}
	if err := d.checkCapabilities(ctx); err != nil {
		return err
	}
	data, err := d.capture(ctx, []string{"image", "inspect", image}, 64<<10)
	if err != nil {
		return port.ErrUnavailable
	}
	var images []struct {
		ID          string   `json:"Id"`
		OS          string   `json:"Os"`
		RepoDigests []string `json:"RepoDigests"`
		Config      struct {
			User        string                     `json:"User"`
			Entrypoint  []string                   `json:"Entrypoint"`
			Labels      map[string]string          `json:"Labels"`
			Volumes     map[string]json.RawMessage `json:"Volumes"`
			Healthcheck *struct {
				Test []string `json:"Test"`
			} `json:"Healthcheck"`
		} `json:"Config"`
	}
	if json.Unmarshal(data, &images) != nil || len(images) != 1 {
		return port.ErrUnavailable
	}
	item := images[0]
	if item.OS != "linux" || len(item.Config.Volumes) != 0 || item.Config.User != "65532:65532" ||
		item.Config.Labels["io.deeix.agent.runner"] != runnerName ||
		item.Config.Labels["io.deeix.agent.runner-version"] != runnerVersion ||
		item.Config.Labels["io.deeix.agent.protocol"] != runnerProtocol ||
		!sameStrings(item.Config.Entrypoint, []string{runnerPython, "-I", runnerScript}) ||
		item.Config.Healthcheck == nil || !sameStrings(item.Config.Healthcheck.Test, []string{"CMD", runnerPython, "-I", runnerScript, "--healthcheck"}) ||
		!imageIdentityMatches(item.ID, item.RepoDigests, image) {
		return port.ErrUnavailable
	}
	return nil
}

// imageIdentityMatches 对仓库 digest 沿用 RepoDigests，对本地镜像 ID 精确比较 inspect 的 .Id。
func imageIdentityMatches(id string, repoDigests []string, image string) bool {
	if strings.HasPrefix(image, "sha256:") {
		return id == image
	}
	return contains(repoDigests, image)
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == want {
			return true
		}
	}
	return false
}
