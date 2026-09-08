package llm

import (
	"math"
	"reflect"
	"testing"
)

func TestIntegerOption(t *testing.T) {
	tests := []struct {
		name   string
		value  any
		want   int
		wantOK bool
	}{
		{name: "int", value: 3, want: 3, wantOK: true},
		{name: "int64", value: int64(4), want: 4, wantOK: true},
		{name: "integral float", value: float64(5), want: 5, wantOK: true},
		{name: "fractional float", value: 1.5},
		{name: "overflow", value: math.Inf(1)},
		{name: "string", value: "6"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := IntegerOption(map[string]any{"value": test.value}, "value")
			if got != test.want || ok != test.wantOK {
				t.Fatalf("IntegerOption() = (%d, %v), want (%d, %v)", got, ok, test.want, test.wantOK)
			}
		})
	}
}

func TestSanitizeXAIVideoOptions(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  map[string]any
	}{
		{name: "empty", input: map[string]any{}, want: map[string]any{}},
		{
			name:  "canonical params kept",
			input: map[string]any{"aspect_ratio": "16:9", "duration": 6, "resolution": "720p"},
			want:  map[string]any{"aspect_ratio": "16:9", "duration": 6, "resolution": "720p"},
		},
		{
			name:  "custom resolution normalized and kept",
			input: map[string]any{"resolution": "768P"},
			want:  map[string]any{"resolution": "768p"},
		},
		{
			name:  "malformed resolution dropped",
			input: map[string]any{"resolution": "high"},
			want:  map[string]any{},
		},
		{
			name:  "unrelated keys pass through untouched",
			input: map[string]any{"duration": 5, "seed": 42},
			want:  map[string]any{"duration": 5, "seed": 42},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			SanitizeXAIVideoOptions(test.input)
			if !reflect.DeepEqual(test.input, test.want) {
				t.Fatalf("SanitizeXAIVideoOptions() = %v, want %v", test.input, test.want)
			}
		})
	}
}
