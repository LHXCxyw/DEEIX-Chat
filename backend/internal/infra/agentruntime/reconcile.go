package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

type orphanBinding struct{ TaskID, OperationID string }

var containerID = regexp.MustCompile(`^[a-f0-9]{64}$`)

// ReconcileOrphans 只重试本适配器已完成执行且清理失败的随机名称。
// 不扫描 Docker 全局容器，也不将其他实例的标签当作删除授权。
func (d *Docker) ReconcileOrphans() error {
	return d.ReconcileOrphansContext(context.Background())
}

func (d *Docker) ReconcileOrphansContext(parent context.Context) error {
	d.mu.Lock()
	candidates := make(map[string]orphanBinding, len(d.orphans))
	for name, binding := range d.orphans {
		candidates[name] = binding
	}
	d.mu.Unlock()
	var result error
	for name, binding := range candidates {
		if err := parent.Err(); err != nil {
			return errors.Join(result, err)
		}
		ctx, cancel := context.WithTimeout(parent, 5*time.Second)
		raw, err := d.capture(ctx, []string{"container", "inspect", "--format", "{{json .}}", name}, 16<<10)
		cancel()
		var info struct {
			ID     string `json:"Id"`
			Config struct{ Labels map[string]string }
		}
		if err == nil {
			err = json.Unmarshal(raw, &info)
			labels := info.Config.Labels
			if err == nil && (!containerID.MatchString(info.ID) || binding.TaskID == "" || binding.OperationID == "" || labels["com.deeix.agent.managed"] != "v1" || labels["com.deeix.agent.owner"] != d.owner || labels["com.deeix.agent.task"] != binding.TaskID || labels["com.deeix.agent.operation"] != binding.OperationID) {
				err = port.ErrDenied
			}
		}
		if err != nil {
			result = errors.Join(result, port.ErrCleanup, err)
			continue
		}
		// 按核验后的不可变 ID 删除，防止名称被其他容器复用。
		if err := d.cleanup(info.ID); err != nil {
			result = errors.Join(result, err)
			continue
		}
		d.mu.Lock()
		delete(d.orphans, name)
		d.mu.Unlock()
	}
	return result
}
