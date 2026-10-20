package config

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// AgentCommandConfig 仅由管理员启动环境配置，不接受用户或模型参数。
type AgentCommandConfig struct {
	Enabled       bool
	Image         string
	AllowedImages []string
}

func LoadAgentCommandConfig() (AgentCommandConfig, error) {
	c := AgentCommandConfig{}
	enabled := strings.TrimSpace(os.Getenv("AGENT_COMMAND_ENABLED"))
	if enabled == "" || enabled == "false" {
		return c, nil
	}
	if enabled != "true" {
		return c, fmt.Errorf("AGENT_COMMAND_ENABLED 必须为 true 或 false")
	}
	c.Enabled = true
	c.Image = strings.TrimSpace(os.Getenv("AGENT_COMMAND_IMAGE"))
	c.AllowedImages = strings.Split(os.Getenv("AGENT_COMMAND_ALLOWED_IMAGES"), ",")
	return c, c.Validate()
}

// immutableImage 允许仓库 digest 或 Compose 本地构建镜像的内容寻址 ID。
var immutableImage = regexp.MustCompile(`^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$`)

func (c AgentCommandConfig) Validate() error {
	if !c.Enabled {
		return nil
	}
	found := false
	for _, image := range c.AllowedImages {
		if !immutableImage.MatchString(image) {
			return fmt.Errorf("命令 runner 白名单必须使用不可变镜像 digest 或本地 sha256 镜像 ID")
		}
		found = found || image == c.Image
	}
	if !found {
		return fmt.Errorf("命令 runner 镜像不在管理员不可变镜像白名单中")
	}
	return nil
}
