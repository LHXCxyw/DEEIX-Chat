// Package agentruntime 定义一次性隔离执行契约，不包含聊天或任务编排。
package agentruntime

import (
	"context"
	"errors"
	"time"
)

var (
	ErrContainerNotFound = errors.New("agentruntime: container not found")
	ErrDenied            = errors.New("agentruntime: execution denied")
	ErrInvalid           = errors.New("agentruntime: invalid request")
	ErrUnavailable       = errors.New("agentruntime: isolation unavailable")
	ErrOutputLimit       = errors.New("agentruntime: output limit exceeded")
	ErrCleanup           = errors.New("agentruntime: container cleanup failed")
)

type NetworkPolicy string

const NetworkNone NetworkPolicy = "none"

type WorkspacePolicy string

const WorkspaceEphemeral WorkspacePolicy = "ephemeral_tmpfs"

// Permission 必须由上层授权服务构造，不能直接相信模型或 HTTP 请求中的授权声明。
type Permission struct {
	TaskID      string
	WorkspaceID string
	ExecuteCode bool
	Network     NetworkPolicy
	Workspace   WorkspacePolicy
}

// Limits 中 WorkspaceBytes 只约束临时工作目录，不承诺持久卷磁盘配额。
type Limits struct {
	MilliCPUs      int64
	MemoryBytes    int64
	PIDs           int64
	WorkspaceBytes int64
	InputBytes     int64
	OutputBytes    int64
	Timeout        time.Duration
}

// Request 只通过标准输入传入数据；不接受宿主路径、挂载、秘密或环境变量。
// Command 是容器内 argv，不是宿主 shell 命令。首项必须是绝对可执行路径。
type ContainerIdentity struct {
	ID          string
	Owner       string
	TaskID      string
	OperationID string
}

type Recoverer interface {
	RecoverContainer(context.Context, ContainerIdentity) error
}

type Request struct {
	BindContainer func(context.Context, ContainerIdentity) error
	OperationID   string
	TaskID        string
	WorkspaceID   string
	Permission    Permission
	Image         string
	Command       []string
	Stdin         []byte
	Limits        Limits
}

// Result 的退出码来自容器检查；非零退出码不等同于适配器错误。
// Output 为按到达顺序合并的 stdout/stderr，不支持文件导出。
type Result struct {
	ContainerName string
	Output        []byte
	ExitCode      int
}

type Executor interface {
	Execute(context.Context, Request) (Result, error)
}
