package agentruntime

import (
	"context"
	"encoding/json"
	"time"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

type ProjectBrowser struct{ *Docker }

func NewProjectBrowser(runner Runner, images []string) (*ProjectBrowser, error) {
	d, err := NewDocker(runner, images)
	if err != nil {
		return nil, err
	}
	d.browserPolicy = true
	return &ProjectBrowser{Docker: d}, nil
}

func (d *ProjectBrowser) CheckReadiness(ctx context.Context, image string) error {
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
	if item.OS != "linux" || item.Config.User != "65532:65532" || len(item.Config.Volumes) != 0 || !imageIdentityMatches(item.ID, item.RepoDigests, image) || item.Config.Labels["io.deeix.agent.sandbox-policy"] != browserSeccompPolicy || item.Config.Labels["io.deeix.agent.runner"] != "deeix-agent-project-browser" || item.Config.Labels["io.deeix.agent.runner-version"] != "1.0.0" || item.Config.Labels["io.deeix.agent.protocol"] != "1" || !sameStrings(item.Config.Entrypoint, []string{"/usr/local/bin/node", "/app/src/project-browser-cli.js"}) || item.Config.Healthcheck == nil || !sameStrings(item.Config.Healthcheck.Test, []string{"CMD", "/usr/local/bin/node", "/app/src/project-browser-cli.js", "--selftest"}) {
		return port.ErrUnavailable
	}
	// readiness 只校验 daemon 与镜像元数据；真实 Chromium 沙箱由每次任务执行自检，
	// 避免能力查询在数秒内启动浏览器导致误报不可用。
	return nil
}

func (d *ProjectBrowser) Execute(ctx context.Context, r port.Request) (port.Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if !sameStrings(r.Command, []string{"/usr/local/bin/node", "/app/src/project-browser-cli.js"}) {
		return port.Result{}, port.ErrDenied
	}
	if err := d.CheckReadiness(ctx, r.Image); err != nil {
		return port.Result{}, err
	}
	return d.Docker.Execute(ctx, r)
}
