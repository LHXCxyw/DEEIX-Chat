package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
	"time"
)

// RecoverContainer 只接受控制平面从数据库读取的不可变身份，不扫描或推测名称。
func (d *Docker) RecoverContainer(parent context.Context, binding port.ContainerIdentity) error {
	if !containerID.MatchString(binding.ID) || !containerID.MatchString(binding.Owner) || binding.TaskID == "" || binding.OperationID == "" {
		return port.ErrDenied
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	inspect := []string{"container", "inspect", "--format", "{{json .}}", binding.ID}
	raw, err := d.capture(ctx, inspect, 16<<10)
	if errors.Is(err, port.ErrContainerNotFound) {
		return nil
	}
	if err != nil {
		return errors.Join(port.ErrCleanup, err)
	}
	var info struct {
		ID     string `json:"Id"`
		Config struct{ Labels map[string]string }
		State  struct {
			Running bool
			Status  string
		}
	}
	if json.Unmarshal(raw, &info) != nil || info.ID != binding.ID || info.Config.Labels["com.deeix.agent.managed"] != "v1" || info.Config.Labels["com.deeix.agent.owner"] != binding.Owner || info.Config.Labels["com.deeix.agent.task"] != binding.TaskID || info.Config.Labels["com.deeix.agent.operation"] != binding.OperationID {
		return port.ErrDenied
	}
	if info.State.Running || (info.State.Status != "created" && info.State.Status != "exited" && info.State.Status != "dead") {
		return port.ErrDenied
	}
	if err := d.cleanup(binding.ID); err != nil {
		return err
	}
	_, err = d.capture(ctx, inspect, 16<<10)
	if !errors.Is(err, port.ErrContainerNotFound) {
		return errors.Join(port.ErrCleanup, err)
	}
	return nil
}
