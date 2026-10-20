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
			name: "canonical params kept",
			input: map[string]any{
				"seconds":         8,
				"resolution_name": "720p",
				"ratio":           "16:9",
				"size":            "1280x720",
				"mode":            "reference",
				"generate_audio":  true,
				"watermark":       false,
			},
			want: map[string]any{
				"seconds":         8,
				"resolution_name": "720p",
				"ratio":           "16:9",
				"size":            "1280x720",
				"mode":            "reference",
				"generate_audio":  true,
				"watermark":       false,
			},
		},
		{
			name:  "float seconds normalized to integer",
			input: map[string]any{"seconds": float64(5)},
			want:  map[string]any{"seconds": 5},
		},
		{
			name:  "seconds accepts upper bound",
			input: map[string]any{"seconds": 30},
			want:  map[string]any{"seconds": 30},
		},
		{
			name:  "seconds below minimum dropped",
			input: map[string]any{"seconds": 3},
			want:  map[string]any{},
		},
		{
			name:  "seconds above maximum dropped",
			input: map[string]any{"seconds": 31},
			want:  map[string]any{},
		},
		{
			name:  "seconds with unit suffix normalized",
			input: map[string]any{"seconds": "8s"},
			want:  map[string]any{"seconds": 8},
		},
		{
			name:  "ratio 21:9 kept",
			input: map[string]any{"ratio": "21:9"},
			want:  map[string]any{"ratio": "21:9"},
		},
		{
			name:  "ratio uppercased normalized",
			input: map[string]any{"ratio": "16:9"},
			want:  map[string]any{"ratio": "16:9"},
		},
		{
			name:  "unsupported ratio dropped",
			input: map[string]any{"ratio": "wide"},
			want:  map[string]any{},
		},
		{
			name:  "frames mode kept",
			input: map[string]any{"seconds": 8, "mode": "frames"},
			want:  map[string]any{"seconds": 8, "mode": "frames"},
		},
		{
			name:  "reference mode kept",
			input: map[string]any{"mode": "reference"},
			want:  map[string]any{"mode": "reference"},
		},
		{
			name:  "mode uppercased normalized",
			input: map[string]any{"mode": "FRAMES"},
			want:  map[string]any{"mode": "frames"},
		},
		{
			name:  "unknown mode dropped",
			input: map[string]any{"mode": "first_last_frame"},
			want:  map[string]any{},
		},
		{
			name:  "non string mode dropped",
			input: map[string]any{"mode": true},
			want:  map[string]any{},
		},
		{
			name:  "tier resolution name kept and lowercased",
			input: map[string]any{"resolution_name": "768P"},
			want:  map[string]any{"resolution_name": "768p"},
		},
		{
			name:  "kilo tier resolution name kept",
			input: map[string]any{"resolution_name": "2K"},
			want:  map[string]any{"resolution_name": "2k"},
		},
		{
			name:  "pixel form is not a resolution name",
			input: map[string]any{"resolution_name": "2560x1440"},
			want:  map[string]any{},
		},
		{
			name:  "malformed resolution name dropped",
			input: map[string]any{"seconds": 5, "resolution_name": "high-720"},
			want:  map[string]any{"seconds": 5},
		},
		{
			name:  "non string resolution name dropped",
			input: map[string]any{"resolution_name": 720},
			want:  map[string]any{},
		},
		{
			name:  "explicit pixel size kept",
			input: map[string]any{"size": "2560x1440"},
			want:  map[string]any{"size": "2560x1440"},
		},
		{
			name:  "malformed pixel size dropped",
			input: map[string]any{"size": "1280*720"},
			want:  map[string]any{},
		},
		{
			name:  "boolean switches kept",
			input: map[string]any{"generate_audio": true, "watermark": false},
			want:  map[string]any{"generate_audio": true, "watermark": false},
		},
		{
			name:  "string boolean switches normalized",
			input: map[string]any{"generate_audio": "true", "watermark": "false"},
			want:  map[string]any{"generate_audio": true, "watermark": false},
		},
		{
			name:  "invalid boolean switches dropped",
			input: map[string]any{"generate_audio": "yes", "watermark": 1},
			want:  map[string]any{},
		},
		{
			name: "legacy keys dropped",
			input: map[string]any{
				"seconds":         5,
				"duration":        5,
				"aspect_ratio":    "16:9",
				"resolution":      "720p",
				"first_last_frame": true,
			},
			want: map[string]any{"seconds": 5},
		},
		{
			name:  "unknown keys dropped",
			input: map[string]any{"seconds": 5, "seed": 42, "style": "vivid"},
			want:  map[string]any{"seconds": 5},
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

func TestOpenAIVideoSizeFromTierAndRatio(t *testing.T) {
	tests := []struct {
		name  string
		tier  string
		ratio string
		want  string
	}{
		{name: "720p landscape", tier: "720p", ratio: "16:9", want: "1280x720"},
		{name: "720p portrait", tier: "720p", ratio: "9:16", want: "720x1280"},
		{name: "720p square", tier: "720p", ratio: "1:1", want: "720x720"},
		{name: "720p four three", tier: "720p", ratio: "4:3", want: "960x720"},
		{name: "720p ultra wide", tier: "720p", ratio: "21:9", want: "1680x720"},
		{name: "1080p landscape", tier: "1080p", ratio: "16:9", want: "1920x1080"},
		{name: "2k uses 2048 short side", tier: "2k", ratio: "16:9", want: "3641x2048"},
		{name: "tier case insensitive", tier: "720P", ratio: "16:9", want: "1280x720"},
		{name: "missing ratio", tier: "720p", ratio: "", want: ""},
		{name: "unsupported ratio", tier: "720p", ratio: "wide", want: ""},
		{name: "pixel size is not a tier", tier: "1280x720", ratio: "16:9", want: ""},
		{name: "missing tier", tier: "", ratio: "16:9", want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := OpenAIVideoSizeFromTierAndRatio(test.tier, test.ratio); got != test.want {
				t.Fatalf("OpenAIVideoSizeFromTierAndRatio(%q, %q) = %q, want %q", test.tier, test.ratio, got, test.want)
			}
		})
	}
}

func TestOpenAIVideoMode(t *testing.T) {
	tests := []struct {
		name    string
		options map[string]any
		want    string
	}{
		{name: "frames", options: map[string]any{"mode": "frames"}, want: OpenAIVideoModeFrames},
		{name: "reference", options: map[string]any{"mode": "reference"}, want: OpenAIVideoModeReference},
		{name: "absent defaults to reference", options: map[string]any{}, want: OpenAIVideoModeReference},
		{name: "invalid defaults to reference", options: map[string]any{"mode": "first_last_frame"}, want: OpenAIVideoModeReference},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := OpenAIVideoMode(test.options); got != test.want {
				t.Fatalf("OpenAIVideoMode() = %q, want %q", got, test.want)
			}
		})
	}
}
