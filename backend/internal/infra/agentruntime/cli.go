package agentruntime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	port "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/agentruntime"
)

const (
	executionNodeLocal  = "local"
	executionNodeRemote = "remote"
)

// CLI 将 Docker 参数直接传给固定可执行文件，不经宿主 shell。
// 不继承 DOCKER_HOST、令牌、代理等环境；端点只由管理员启动环境决定。
type CLI struct {
	executable string
	globalArgs []string
	node       string
	command    func(context.Context, string, ...string) *exec.Cmd
}

func NewCLI() (*CLI, error) {
	executable, err := exec.LookPath("docker")
	if err != nil {
		return nil, err
	}
	return newCLI(executable)
}

func newCLI(executable string) (*CLI, error) {
	executable, err := filepath.Abs(executable)
	if err != nil {
		return nil, err
	}
	globalArgs, node, err := dockerGlobalArgs()
	if err != nil {
		return nil, err
	}
	return &CLI{executable: executable, globalArgs: globalArgs, node: node}, nil
}

// ExecutionNode 只描述执行节点来源，不包含端点地址、证书路径或凭据。
func (c *CLI) ExecutionNode() string {
	if c.node == executionNodeRemote {
		return executionNodeRemote
	}
	return executionNodeLocal
}

// dockerGlobalArgs 只读取管理员启动环境；空端点保持本地默认 Unix socket。
func dockerGlobalArgs() ([]string, string, error) {
	host := strings.TrimSpace(os.Getenv("AGENT_DOCKER_HOST"))
	tlsVerify, err := booleanEnv("AGENT_DOCKER_TLS_VERIFY")
	if err != nil {
		return nil, "", err
	}
	allowInsecureTCP, err := booleanEnv("AGENT_DOCKER_ALLOW_INSECURE_TCP")
	if err != nil {
		return nil, "", err
	}
	if host == "" {
		if tlsVerify {
			return nil, "", fmt.Errorf("AGENT_DOCKER_TLS_VERIFY=true 时必须设置 AGENT_DOCKER_HOST=tcp://host:port")
		}
		return nil, executionNodeLocal, nil
	}
	if strings.ContainsAny(host, " \t\r\n\x00") {
		return nil, "", fmt.Errorf("AGENT_DOCKER_HOST 含非法空白或控制字符")
	}
	parsed, err := url.Parse(host)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, "", fmt.Errorf("AGENT_DOCKER_HOST 必须是 unix:///path 或 tcp://host:port")
	}
	switch parsed.Scheme {
	case "unix":
		if !strings.HasPrefix(host, "unix:///") || parsed.Host != "" || !path.IsAbs(parsed.Path) || path.Clean(parsed.Path) == "/" {
			return nil, "", fmt.Errorf("AGENT_DOCKER_HOST 的 unix 地址必须是 unix:///绝对路径")
		}
		if tlsVerify {
			return nil, "", fmt.Errorf("unix socket 不需要 TLS，AGENT_DOCKER_TLS_VERIFY 必须为 false")
		}
		return []string{"-H", host}, executionNodeLocal, nil
	case "tcp":
		if !strings.HasPrefix(host, "tcp://") || parsed.Path != "" && parsed.Path != "/" {
			return nil, "", fmt.Errorf("AGENT_DOCKER_HOST 的 tcp 地址必须为 tcp://host:port")
		}
		if err := validateTCPAddress(parsed.Host); err != nil {
			return nil, "", err
		}
		args := []string{"-H", host}
		if tlsVerify {
			ca, cert, key, err := dockerTLSCertificates()
			if err != nil {
				return nil, "", err
			}
			args = append(args, "--tlsverify", "--tlscacert", ca, "--tlscert", cert, "--tlskey", key)
		} else if !allowInsecureTCP {
			return nil, "", fmt.Errorf("拒绝未加密的 tcp Docker 端点；请启用 AGENT_DOCKER_TLS_VERIFY 或显式设置 AGENT_DOCKER_ALLOW_INSECURE_TCP=true")
		}
		return args, executionNodeRemote, nil
	default:
		return nil, "", fmt.Errorf("AGENT_DOCKER_HOST 仅支持 unix:// 或 tcp://，不支持 %q", parsed.Scheme)
	}
}

func booleanEnv(name string) (bool, error) {
	switch value := strings.TrimSpace(os.Getenv(name)); value {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	default:
		return false, fmt.Errorf("%s 必须为 true 或 false", name)
	}
}

func validateTCPAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" {
		return fmt.Errorf("AGENT_DOCKER_HOST 的 tcp 地址必须为 host:port")
	}
	for i := 0; i < len(port); i++ {
		if port[i] < '0' || port[i] > '9' {
			return fmt.Errorf("AGENT_DOCKER_HOST 的 tcp 端口必须为数字")
		}
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return fmt.Errorf("AGENT_DOCKER_HOST 的 tcp 端口必须在 1-65535 之间")
	}
	return nil
}

func dockerTLSCertificates() (string, string, string, error) {
	dir := strings.TrimSpace(os.Getenv("AGENT_DOCKER_CERT_PATH"))
	if dir == "" {
		return "", "", "", fmt.Errorf("AGENT_DOCKER_TLS_VERIFY=true 时必须设置 AGENT_DOCKER_CERT_PATH")
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return "", "", "", fmt.Errorf("AGENT_DOCKER_CERT_PATH 必须是存在的证书目录")
	}
	ca := filepath.Join(dir, "ca.pem")
	cert := filepath.Join(dir, "cert.pem")
	key := filepath.Join(dir, "key.pem")
	for _, file := range []string{ca, cert, key} {
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() {
			return "", "", "", fmt.Errorf("Docker TLS 证书文件缺失或不可读：%s", filepath.Base(file))
		}
	}
	return ca, cert, key, nil
}

func containerAbsentMessage(message, id string) bool {
	return containerID.MatchString(id) && (message == "Error response from daemon: No such container: "+id || message == "Error: No such object: "+id)
}

func (c *CLI) Run(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	if contains(args, "--security-opt=seccomp="+browserSeccompPath) {
		if err := checkBrowserSeccompFile(); err != nil {
			return err
		}
	}
	command := args
	if len(c.globalArgs) > 0 {
		command = make([]string, 0, len(c.globalArgs)+len(args))
		command = append(command, c.globalArgs...)
		command = append(command, args...)
	}
	run := exec.CommandContext
	if c.command != nil {
		run = c.command
	}
	cmd := run(ctx, c.executable, command...)
	cmd.Env = []string{}
	// Windows 创建进程所需的系统目录不是应用秘密。
	if runtime.GOOS == "windows" {
		cmd.Env = append(cmd.Env, "SystemRoot="+os.Getenv("SystemRoot"))
	}
	cmd.Stdin = input
	cmd.Stdout = output
	var stderr bytes.Buffer
	cmd.Stderr = output
	if len(args) == 5 && args[0] == "container" && args[1] == "inspect" {
		cmd.Stderr = io.MultiWriter(output, &stderr)
	}
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	var exit *exec.ExitError
	if ctx.Err() == nil && errors.As(err, &exit) && exit.ExitCode() == 1 && len(args) == 5 && args[0] == "container" && args[1] == "inspect" && containerID.MatchString(args[4]) {
		message := strings.TrimSpace(stderr.String())
		if containerAbsentMessage(message, args[4]) {
			return errors.Join(port.ErrContainerNotFound, err)
		}
	}
	return err
}
