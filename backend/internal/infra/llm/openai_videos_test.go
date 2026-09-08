package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	portllm "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

// 轮询期间上游网关返回瞬时 502 时应退避重试，而不是把仍在执行的任务判死。
func TestGenerateOpenAIVideoToleratesTransientPollFailures(t *testing.T) {
	postCount := 0
	pollCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
			postCount++
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode request body: %v", err)
			}
			if payload["model"] != "comfyui-video" || payload["prompt"] == "" {
				t.Fatalf("unexpected request body: %#v", payload)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"vid_1","status":"queued"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/vid_1":
			pollCount++
			w.Header().Set("Content-Type", "application/json")
			// 前两次轮询模拟网关抖动，第三次返回进度，第四次返回成品
			switch {
			case pollCount <= 2:
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"error":{"message":"gateway hiccup"}}`))
			case pollCount == 3:
				_, _ = w.Write([]byte(`{"id":"vid_1","status":"in_progress","progress":40}`))
			default:
				_, _ = w.Write([]byte(`{"id":"vid_1","status":"completed","video_url":"https://example.com/final.mp4","duration":6}`))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	progressReports := make([]int, 0, 2)
	output, err := newTestClient().Generate(context.Background(), portllm.RouteConfig{
		Protocol:      portllm.AdapterOpenAIVideo,
		BaseURL:       server.URL + "/v1",
		APIKey:        "openai-key",
		ReadTimeoutMS: 30000,
		UpstreamModel: "comfyui-video",
	}, portllm.GenerateInput{
		Messages:   []portllm.Message{{Role: "user", Content: "A cinematic orbit"}},
		OnProgress: func(percent int) { progressReports = append(progressReports, percent) },
	})
	if err != nil {
		t.Fatalf("generate openai video: %v", err)
	}
	if postCount != 1 || pollCount != 4 {
		t.Fatalf("expected one submission and four polls, got post=%d poll=%d", postCount, pollCount)
	}
	if output.ResponseID != "vid_1" || len(output.GeneratedVideos) != 1 {
		t.Fatalf("unexpected openai video output: %#v", output)
	}
	video := output.GeneratedVideos[0]
	if video.URL != "https://example.com/final.mp4" || video.MIMEType != "video/mp4" || video.DurationSeconds != 6 {
		t.Fatalf("unexpected generated video: %#v", video)
	}
	// 进度回调只在上报值变化时触发一次
	if len(progressReports) != 1 || progressReports[0] != 40 {
		t.Fatalf("unexpected progress reports: %#v", progressReports)
	}
}

// 轮询连续瞬时失败超过上限时应判失败，而不是无限等待。
func TestGenerateOpenAIVideoFailsAfterSustainedTransientErrors(t *testing.T) {
	pollCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/videos" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"vid_2","status":"queued"}`))
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/videos/vid_2" {
			pollCount++
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"message":"relay down"}}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	_, err := newTestClient().Generate(context.Background(), portllm.RouteConfig{
		Protocol:      portllm.AdapterOpenAIVideo,
		BaseURL:       server.URL + "/v1",
		APIKey:        "openai-key",
		ReadTimeoutMS: 120000,
		UpstreamModel: "comfyui-video",
	}, portllm.GenerateInput{
		Messages: []portllm.Message{{Role: "user", Content: "A cinematic orbit"}},
	})
	if err == nil {
		t.Fatalf("expected sustained transient errors to fail the task")
	}
	// 提交 1 次 + 连续失败上限次轮询
	if pollCount != maxOpenAIVideoTransientPollFailures {
		t.Fatalf("expected %d polls before giving up, got %d", maxOpenAIVideoTransientPollFailures, pollCount)
	}
}

// 多张参考图应放在 images 字符串数组字段，兼容只接受字符串图片 URL 的中转网关。
func TestBuildOpenAIVideoSubmissionBodyMultiImage(t *testing.T) {
	input := portllm.GenerateInput{
		Messages: []portllm.Message{{
			Role:    "user",
			Content: "两个角色",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "两个角色"},
				{Kind: portllm.ContentPartImage, MimeType: "image/png", Data: []byte{0x01}},
				{Kind: portllm.ContentPartImage, MimeType: "image/png", Data: []byte{0x02}},
			},
		}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("minimax-h3", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	if _, exists := payload["image"]; exists {
		t.Fatalf("multi-image payload should not contain image field: %#v", payload["image"])
	}
	urls, ok := payload["images"].([]string)
	if !ok {
		t.Fatalf("images field should be []string, got %#v", payload["images"])
	}
	if len(urls) != 2 {
		t.Fatalf("expected 2 image urls, got %d", len(urls))
	}
	for i, url := range urls {
		if !strings.HasPrefix(url, "data:image/png;base64,") {
			t.Fatalf("image %d should be a data URL string, got %q", i, url)
		}
	}
}

// 单张参考图仍保持 image 对象字段不变。
func TestBuildOpenAIVideoSubmissionBodySingleImage(t *testing.T) {
	input := portllm.GenerateInput{
		Messages: []portllm.Message{{
			Role:    "user",
			Content: "一个角色",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "一个角色"},
				{Kind: portllm.ContentPartImage, MimeType: "image/png", Data: []byte{0x01}},
			},
		}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("minimax-h3", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	if _, exists := payload["images"]; exists {
		t.Fatalf("single-image payload should not contain images field: %#v", payload["images"])
	}
	image, ok := payload["image"].(map[string]any)
	if !ok {
		t.Fatalf("image field should be an object, got %#v", payload["image"])
	}
	if url, _ := image["url"].(string); !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("image url should be a data URL string, got %q", url)
	}
}

// 参考图携带 URL 时应优先传 URL 字符串，而不是内联 base64。
func TestBuildOpenAIVideoSubmissionBodyPrefersImageURL(t *testing.T) {
	input := portllm.GenerateInput{
		Messages: []portllm.Message{{
			Role: "user",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "两个角色"},
				{Kind: portllm.ContentPartImage, MimeType: "image/png", URL: "https://api.example.com/api/v1/files/f1/signed-content?signature=abc"},
				{Kind: portllm.ContentPartImage, MimeType: "image/png", URL: "https://api.example.com/api/v1/files/f2/signed-content?signature=def"},
			},
		}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("minimax-h3", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	urls, ok := payload["images"].([]string)
	if !ok || len(urls) != 2 {
		t.Fatalf("images field should be []string of 2 urls, got %#v", payload["images"])
	}
	if urls[0] != "https://api.example.com/api/v1/files/f1/signed-content?signature=abc" {
		t.Fatalf("expected remote url preserved, got %q", urls[0])
	}
}
