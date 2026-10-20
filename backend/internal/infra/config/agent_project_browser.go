package config

import (
	"fmt"
	"os"
	"strings"
)

type AgentProjectBrowserConfig struct {
	Enabled       bool
	Image         string
	AllowedImages []string
}

func LoadAgentProjectBrowserConfig() (AgentProjectBrowserConfig, error) {
	c := AgentProjectBrowserConfig{}
	enabled := strings.TrimSpace(os.Getenv("AGENT_PROJECT_BROWSER_ENABLED"))
	if enabled == "" || enabled == "false" {
		return c, nil
	}
	if enabled != "true" {
		return c, fmt.Errorf("AGENT_PROJECT_BROWSER_ENABLED 必须为 true 或 false")
	}
	c.Enabled = true
	c.Image = strings.TrimSpace(os.Getenv("AGENT_PROJECT_BROWSER_IMAGE"))
	c.AllowedImages = strings.Split(os.Getenv("AGENT_PROJECT_BROWSER_ALLOWED_IMAGES"), ",")
	return c, c.Validate()
}
func (c AgentProjectBrowserConfig) Validate() error {
	return (AgentCommandConfig{Enabled: c.Enabled, Image: c.Image, AllowedImages: c.AllowedImages}).Validate()
}
