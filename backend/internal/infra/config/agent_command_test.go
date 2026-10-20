package config

import (
	"strings"
	"testing"
)

func TestAgentCommandConfig(t *testing.T) {
	image := "local/runner@sha256:" + strings.Repeat("a", 64)
	imageID := "sha256:" + strings.Repeat("a", 64)
	for _, tt := range []struct {
		name, enabled, image, allow string
		wantError                   bool
	}{
		{"default disabled", "", "", "", false},
		{"invalid enabled", "yes", "", "", true},
		{"missing config", "true", "", "", true},
		{"mutable image", "true", "local/runner:latest", "local/runner:latest", true},
		{"allowlisted digest", "true", image, image, false},
		{"allowlisted image id", "true", imageID, imageID, false},
		{"short image id", "true", "sha256:" + strings.Repeat("a", 12), "sha256:" + strings.Repeat("a", 12), true},
		{"uppercase image id", "true", "sha256:" + strings.Repeat("A", 64), "sha256:" + strings.Repeat("A", 64), true},
		{"not allowlisted", "true", "other/runner@sha256:" + strings.Repeat("b", 64), image, true},
		{"mixed identity mismatch", "true", imageID, image, true},
		{"image id not allowlisted", "true", imageID, "sha256:" + strings.Repeat("b", 64), true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("AGENT_COMMAND_ENABLED", tt.enabled)
			t.Setenv("AGENT_COMMAND_IMAGE", tt.image)
			t.Setenv("AGENT_COMMAND_ALLOWED_IMAGES", tt.allow)
			_, err := LoadAgentCommandConfig()
			if (err != nil) != tt.wantError {
				t.Fatal(err)
			}
		})
	}
}
