package config

import (
	"fmt"
	"os"
	"strings"
)

// AgentScreenshotConfig 是独立于命令 runner 的管理员启动配置。
type AgentScreenshotConfig struct {
	Enabled       bool
	Image         string
	AllowedImages []string
}

func LoadAgentScreenshotConfig() (AgentScreenshotConfig, error) {
	c := AgentScreenshotConfig{}
	enabled := strings.TrimSpace(os.Getenv("AGENT_SCREENSHOT_ENABLED"))
	if enabled == "" || enabled == "false" {
		return c, nil
	}
	if enabled != "true" {
		return c, fmt.Errorf("AGENT_SCREENSHOT_ENABLED 必须为 true 或 false")
	}
	c.Enabled = true
	c.Image = strings.TrimSpace(os.Getenv("AGENT_SCREENSHOT_IMAGE"))
	c.AllowedImages = strings.Split(os.Getenv("AGENT_SCREENSHOT_ALLOWED_IMAGES"), ",")
	return c, c.Validate()
}

func (c AgentScreenshotConfig) Validate() error {
	if err := (AgentCommandConfig{Enabled: c.Enabled, Image: c.Image, AllowedImages: c.AllowedImages}).Validate(); err != nil {
		return fmt.Errorf("离线截图镜像配置无效：%w", err)
	}
	return nil
}
