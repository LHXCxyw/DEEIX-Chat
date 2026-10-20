package agentruntime

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

// Runner 只执行 Docker argv；实现必须在上下文结束后等待 CLI 进程退出。
type Runner interface {
	Run(context.Context, []string, io.Reader, io.Writer) error
}
type Docker struct {
	runner        Runner
	browserPolicy bool
	images        map[string]bool
	owner         string
	mu            sync.Mutex
	orphans       map[string]orphanBinding
}

var _ port.Executor = (*Docker)(nil)
var digestImage = regexp.MustCompile(`^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$`)

// ExecutionNode 只暴露执行节点来源，不携带端点、证书路径或凭据。
func (d *Docker) ExecutionNode() string {
	if source, ok := d.runner.(interface{ ExecutionNode() string }); ok && source.ExecutionNode() == executionNodeRemote {
		return executionNodeRemote
	}
	return executionNodeLocal
}

// NewDocker 的镜像白名单由管理员提供，必须使用不可变 digest 或内容寻址 ID 且不内嵌秘密。
func NewDocker(runner Runner, allowedImages []string) (*Docker, error) {
	if runner == nil || len(allowedImages) == 0 {
		return nil, port.ErrInvalid
	}
	var owner [32]byte
	if _, err := rand.Read(owner[:]); err != nil {
		return nil, err
	}
	d := &Docker{runner: runner, images: make(map[string]bool), owner: hex.EncodeToString(owner[:]), orphans: make(map[string]orphanBinding)}
	for _, image := range allowedImages {
		if !digestImage.MatchString(image) {
			return nil, fmt.Errorf("%w: immutable image digest or id required", port.ErrInvalid)
		}
		d.images[image] = true
	}
	return d, nil
}
func (d *Docker) validate(r port.Request) error {
	if r.BindContainer == nil || r.OperationID == "" {
		return port.ErrInvalid
	}
	p, l := r.Permission, r.Limits
	if r.TaskID == "" || r.WorkspaceID == "" || !p.ExecuteCode || p.TaskID != r.TaskID || p.WorkspaceID != r.WorkspaceID || p.Network != port.NetworkNone || p.Workspace != port.WorkspaceEphemeral || !d.images[r.Image] {
		return port.ErrDenied
	}
	if l.MilliCPUs <= 0 || l.MilliCPUs > 2000 || l.MemoryBytes < 16<<20 || l.MemoryBytes > 2<<30 || l.PIDs <= 0 || l.PIDs > 128 || l.WorkspaceBytes <= 0 || l.WorkspaceBytes > 1<<30 || l.WorkspaceBytes > l.MemoryBytes || l.InputBytes <= 0 || l.InputBytes > 8<<20 || l.OutputBytes <= 0 || l.OutputBytes > 8<<20 || l.Timeout <= 0 || l.Timeout > 120*time.Second || int64(len(r.Stdin)) > l.InputBytes {
		return port.ErrInvalid
	}
	if len(r.Command) == 0 || !strings.HasPrefix(r.Command[0], "/") || path.Clean(r.Command[0]) != r.Command[0] {
		return port.ErrInvalid
	}
	size := 0
	for _, arg := range r.Command {
		size += len(arg)
		if strings.ContainsRune(arg, 0) {
			return port.ErrInvalid
		}
	}
	if size > 64<<10 {
		return port.ErrInvalid
	}
	return nil
}
func (d *Docker) Execute(ctx context.Context, r port.Request) (result port.Result, err error) {
	result.ExitCode = -1
	if err = d.validate(r); err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, r.Limits.Timeout)
	defer cancel()
	if err = ctx.Err(); err != nil {
		return result, err
	}
	if err = d.checkCapabilities(ctx); err != nil {
		return result, err
	}
	// 镜像自带 VOLUME 会绕过临时工作区配额，必须在创建前拒绝。
	metadata, runErr := d.capture(ctx, []string{"image", "inspect", r.Image}, 64<<10)
	if runErr != nil {
		return result, errors.Join(port.ErrUnavailable, ctx.Err(), runErr)
	}
	var images []struct {
		OS     string `json:"Os"`
		Config struct {
			Volumes map[string]json.RawMessage `json:"Volumes"`
		} `json:"Config"`
	}
	if json.Unmarshal(metadata, &images) != nil || len(images) != 1 || images[0].OS != "linux" || len(images[0].Config.Volumes) != 0 {
		return result, fmt.Errorf("%w: linux image without volumes required", port.ErrDenied)
	}
	var token [16]byte
	if _, err = rand.Read(token[:]); err != nil {
		return result, err
	}
	result.ContainerName = "deeix-agent-" + hex.EncodeToString(token[:])
	// 即使 create 因取消返回错误，守护进程也可能已创建容器，仍按已知名称清理。
	cleanupTarget := result.ContainerName
	defer func() {
		cleanupErr := d.cleanup(cleanupTarget)
		if cleanupErr != nil {
			d.mu.Lock()
			d.orphans[result.ContainerName] = orphanBinding{TaskID: r.TaskID, OperationID: r.OperationID}
			d.mu.Unlock()
		}
		err = errors.Join(err, cleanupErr)
	}()
	args := d.createArgs(r, result.ContainerName)
	// 标签只由控制平面生成，不接受命令或模型提供的管理身份。
	args = append(args[:1], append([]string{"--label=com.deeix.agent.managed=v1", "--label=com.deeix.agent.owner=" + d.owner, "--label=com.deeix.agent.task=" + r.TaskID, "--label=com.deeix.agent.operation=" + r.OperationID}, args[1:]...)...)
	created, createErr := d.capture(ctx, args, 4096)
	if createErr != nil {
		return result, errors.Join(ctx.Err(), port.ErrUnavailable, createErr)
	}
	id := strings.TrimSpace(string(created))
	if !containerID.MatchString(id) {
		return result, port.ErrUnavailable
	}
	cleanupTarget = id
	if r.BindContainer != nil {
		if err = r.BindContainer(ctx, port.ContainerIdentity{ID: id, Owner: d.owner, TaskID: r.TaskID, OperationID: r.OperationID}); err != nil {
			return result, err
		}
	}
	if d.browserPolicy {
		metadata, inspectErr := d.capture(ctx, []string{"container", "inspect", id}, 64<<10)
		var containers []struct {
			Config struct {
				User   string
				Labels map[string]string
			}
			HostConfig struct {
				NetworkMode    string
				ReadonlyRootfs bool
				Privileged     bool
				Binds          []string
				CapDrop        []string
				CapAdd         []string
				SecurityOpt    []string
			}
			Mounts []struct {
				Type        string
				Destination string
			}
			NetworkSettings struct{ Networks map[string]json.RawMessage }
		}
		if inspectErr != nil || json.Unmarshal(metadata, &containers) != nil || len(containers) != 1 {
			return result, port.ErrUnavailable
		}
		item := containers[0]
		if item.HostConfig.NetworkMode != "none" || !item.HostConfig.ReadonlyRootfs || item.HostConfig.Privileged || len(item.HostConfig.Binds) != 0 || item.Config.User != "65532:65532" || !contains(item.HostConfig.CapDrop, "ALL") || !browserSecurityOptions(item.HostConfig.SecurityOpt) || !sameStrings(item.HostConfig.CapAdd, []string{"SYS_CHROOT"}) || item.Config.Labels["com.deeix.agent.seccomp"] != browserSeccompPolicy || item.Config.Labels["com.deeix.agent.owner"] != d.owner || item.Config.Labels["com.deeix.agent.operation"] != r.OperationID || len(item.NetworkSettings.Networks) > 1 {
			return result, port.ErrDenied
		}
		for name := range item.NetworkSettings.Networks {
			if name != "none" {
				return result, port.ErrDenied
			}
		}
		for _, mount := range item.Mounts {
			if mount.Type != "tmpfs" || mount.Destination != "/workspace" {
				return result, port.ErrDenied
			}
		}
	}
	output := &boundedOutput{limit: r.Limits.OutputBytes, cancel: cancel}
	startErr := d.runner.Run(ctx, []string{"start", "--attach", "--interactive", id}, bytes.NewReader(r.Stdin), output)
	result.Output = output.bytes()
	if output.exceeded() {
		return result, port.ErrOutputLimit
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	state, inspectErr := d.capture(ctx, []string{"container", "inspect", "--format", "{{json .State}}", id}, 4096)
	if inspectErr != nil {
		return result, errors.Join(port.ErrUnavailable, ctx.Err(), startErr, inspectErr)
	}
	var status struct {
		Status   string
		Running  bool
		ExitCode int
		Error    string
	}
	if json.Unmarshal(state, &status) != nil || status.Running || status.Status != "exited" || status.Error != "" {
		return result, errors.Join(port.ErrUnavailable, startErr)
	}
	result.ExitCode = status.ExitCode
	// docker start --attach 以容器退出码退出；只有已确认的非零容器退出可忽略 CLI 错误。
	if startErr != nil && status.ExitCode == 0 {
		return result, errors.Join(port.ErrUnavailable, startErr)
	}
	return result, nil
}
func createArgs(r port.Request, name string) []string {
	l := r.Limits
	args := []string{"create", "--name", name, "--pull=never", "--platform=linux", "--user=65532:65532", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true", "--cpus=" + strconv.FormatFloat(float64(l.MilliCPUs)/1000, 'f', 3, 64), "--memory=" + strconv.FormatInt(l.MemoryBytes, 10), "--memory-swap=" + strconv.FormatInt(l.MemoryBytes, 10), "--pids-limit=" + strconv.FormatInt(l.PIDs, 10), "--ipc=private", "--ulimit=core=0:0", "--log-driver=none", "--restart=no", "--no-healthcheck", "--init", "--interactive", "--workdir=/workspace", "--env=HOME=/workspace", "--env=TMPDIR=/workspace", "--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=" + strconv.FormatInt(l.WorkspaceBytes, 10) + ",mode=1777", "--entrypoint", r.Command[0], r.Image}
	return append(args, r.Command[1:]...)
}
func (d *Docker) capture(ctx context.Context, args []string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := &boundedOutput{limit: limit, cancel: cancel}
	err := d.runner.Run(ctx, args, nil, out)
	if out.exceeded() {
		return nil, port.ErrOutputLimit
	}
	return out.bytes(), err
}
func (d *Docker) cleanup(name string) error {
	// 清理不得继承已取消的请求上下文；stop 和强制删除各有独立时间预算。
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, stopErr := d.capture(stopCtx, []string{"stop", "--time=0", name}, 4096)
	stopCancel()
	rmCtx, rmCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, rmErr := d.capture(rmCtx, []string{"rm", "--force", "--volumes", name}, 4096)
	rmCancel()
	// 强制删除成功已证明容器被回收，即使 stop 报告容器未运行也不影响结果。
	if rmErr != nil {
		return errors.Join(port.ErrCleanup, stopErr, rmErr)
	}
	return nil
}

type boundedOutput struct {
	mu       sync.Mutex
	data     []byte
	limit    int64
	overflow bool
	cancel   context.CancelFunc
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := b.limit - int64(len(b.data))
	if int64(n) > remaining {
		b.data = append(b.data, p[:int(remaining)]...)
		b.overflow = true
		b.cancel()
	} else {
		b.data = append(b.data, p...)
	}
	// 接收并丢弃超额字节，保证 CLI 的管道可以被正常回收。
	return n, nil
}
func (b *boundedOutput) bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.data...)
}
func (b *boundedOutput) exceeded() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.overflow }
