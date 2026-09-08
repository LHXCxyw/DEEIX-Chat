package llm

import (
	"reflect"
	"testing"
)

func TestSanitizeOpenAIVideoOptions(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  map[string]any
	}{
		{name: "empty", input: map[string]any{}, want: map[string]any{}},
		{
			name:  "canonical params kept",
			input: map[string]any{"duration": 8, "resolution": "720p", "aspect_ratio": "16:9"},
			want:  map[string]any{"duration": 8, "resolution": "720p", "aspect_ratio": "16:9"},
		},
		{
			name:  "aliases normalized",
			input: map[string]any{"seconds": float64(5), "size": "1280x720", "aspect_ratio": "9:16"},
			want:  map[string]any{"duration": 5, "resolution": "720p", "aspect_ratio": "9:16"},
		},
		{
			name:  "duration alias wins over invalid duration",
			input: map[string]any{"duration": 30, "seconds": 4},
			want:  map[string]any{"duration": 4},
		},
		{
			name:  "resolution alias wins over invalid resolution",
			input: map[string]any{"resolution": "ultra", "size": "1920x1080"},
			want:  map[string]any{"resolution": "1080p"},
		},
		{
			name:  "custom resolution presets kept",
			input: map[string]any{"resolution": "768P", "aspect_ratio": "16:9"},
			want:  map[string]any{"resolution": "768p", "aspect_ratio": "16:9"},
		},
		{
			name:  "custom tier and pixel resolutions kept",
			input: map[string]any{"resolution": "2K"},
			want:  map[string]any{"resolution": "2k"},
		},
		{
			name:  "custom width x height resolution kept",
			input: map[string]any{"resolution": "2560x1440"},
			want:  map[string]any{"resolution": "2560x1440"},
		},
		{
			name:  "malformed custom resolution dropped",
			input: map[string]any{"duration": 5, "resolution": "high-720"},
			want:  map[string]any{"duration": 5},
		},
		{
			name:  "out of range duration dropped",
			input: map[string]any{"duration": 0, "resolution": "480p"},
			want:  map[string]any{"resolution": "480p"},
		},
		{
			name:  "unknown keys dropped",
			input: map[string]any{"duration": 5, "seed": 42, "style": "vivid", "seconds": "20"},
			want:  map[string]any{"duration": 5},
		},
		{
			name:  "non string resolution dropped",
			input: map[string]any{"resolution": 720},
			want:  map[string]any{},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			SanitizeOpenAIVideoOptions(test.input)
			if !reflect.DeepEqual(test.input, test.want) {
				t.Fatalf("SanitizeOpenAIVideoOptions() = %v, want %v", test.input, test.want)
			}
		})
	}
}
