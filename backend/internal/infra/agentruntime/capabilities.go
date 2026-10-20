package agentruntime

import (
	"context"
	"encoding/json"
	"errors"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

func (d *Docker) checkCapabilities(ctx context.Context) error {
	data, err := d.capture(ctx, []string{"info", "--format", "{{json .}}"}, 64<<10)
	if err != nil {
		return errors.Join(port.ErrUnavailable, ctx.Err(), err)
	}
	var info struct {
		OSType       string
		MemoryLimit  bool
		SwapLimit    bool
		CpuCfsQuota  bool
		CpuCfsPeriod bool
		PidsLimit    bool
		Warnings     []string
	}
	// 不接受仅警告而忽略资源约束的守护进程；未知字段缺省为不支持。
	if json.Unmarshal(data, &info) != nil || info.OSType != "linux" || !info.MemoryLimit || !info.SwapLimit || !info.CpuCfsQuota || !info.CpuCfsPeriod || !info.PidsLimit || len(info.Warnings) != 0 {
		return port.ErrUnavailable
	}
	return nil
}
