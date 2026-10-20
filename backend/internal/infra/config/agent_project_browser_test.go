package config

import (
	"strings"
	"testing"
)

func TestAgentProjectBrowserConfig(t *testing.T) {
	image := "local/browser@sha256:" + strings.Repeat("a", 64)
	imageID := "sha256:" + strings.Repeat("a", 64)
	for _, tt := range []struct {
		name, enabled, image, allow string
		wantError                   bool
	}{
		{"默认关闭", "", image, image, false},
		{"启用", "true", image, image, false},
		{"镜像ID", "true", imageID, imageID, false},
		{"tag拒绝", "true", "local/browser:latest", "local/browser:latest", true},
		{"短ID拒绝", "true", "sha256:" + strings.Repeat("a", 12), "sha256:" + strings.Repeat("a", 12), true},
		{"白名单拒绝", "true", image, "local/other@sha256:" + strings.Repeat("b", 64), true},
		{"混合身份不匹配", "true", imageID, image, true},
		{"无效开关", "yes", image, image, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("AGENT_PROJECT_BROWSER_ENABLED", tt.enabled)
			t.Setenv("AGENT_PROJECT_BROWSER_IMAGE", tt.image)
			t.Setenv("AGENT_PROJECT_BROWSER_ALLOWED_IMAGES", tt.allow)
			cfg, err := LoadAgentProjectBrowserConfig()
			if (err != nil) != tt.wantError {
				t.Fatal(err)
			}
			if tt.enabled == "" && cfg.Enabled {
				t.Fatal("默认必须关闭")
			}
		})
	}
}
