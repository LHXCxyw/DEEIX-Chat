package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

	output, err := newTestClient().Generate(context.Background(), portllm.RouteConfig{
		Protocol:      portllm.AdapterOpenAIVideo,
		BaseURL:       server.URL + "/v1",
		APIKey:        "openai-key",
		ReadTimeoutMS: 30000,
		UpstreamModel: "comfyui-video",
	}, portllm.GenerateInput{
		Messages: []portllm.Message{{Role: "user", Content: "A cinematic orbit"}},
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

// 多张参考图以签名 URL 字符串数组进入 images 字段。
func TestBuildOpenAIVideoSubmissionBodyMultiImage(t *testing.T) {
	input := portllm.GenerateInput{
		Messages: []portllm.Message{{
			Role:    "user",
			Content: "两个角色",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "两个角色"},
				{Kind: portllm.ContentPartImage, URL: "https://cdn.example.com/reference-1.png"},
				{Kind: portllm.ContentPartImage, URL: "https://cdn.example.com/reference-2.png"},
			},
		}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("minimax-h3", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	if payload["mode"] != portllm.OpenAIVideoModeReference {
		t.Fatalf("payload mode = %#v, want reference", payload["mode"])
	}
	if _, exists := payload["image"]; exists {
		t.Fatalf("multi-image payload should not contain image field: %#v", payload["image"])
	}
	urls, ok := payload["images"].([]string)
	if !ok {
		t.Fatalf("images field should be []string, got %#v", payload["images"])
	}
	want := []string{"https://cdn.example.com/reference-1.png", "https://cdn.example.com/reference-2.png"}
	if len(urls) != len(want) {
		t.Fatalf("expected %d image urls, got %d", len(want), len(urls))
	}
	for i, url := range urls {
		if url != want[i] {
			t.Fatalf("image %d = %q, want %q", i, url, want[i])
		}
	}
}

// 单张参考图同样走 images 数组，与协议字段保持一致。
func TestBuildOpenAIVideoSubmissionBodySingleImage(t *testing.T) {
	input := portllm.GenerateInput{
		Messages: []portllm.Message{{
			Role:    "user",
			Content: "一个角色",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "一个角色"},
				{Kind: portllm.ContentPartImage, URL: "https://cdn.example.com/reference.png"},
			},
		}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("minimax-h3", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	if _, exists := payload["image"]; exists {
		t.Fatalf("payload should not contain image field: %#v", payload["image"])
	}
	urls, ok := payload["images"].([]string)
	if !ok || len(urls) != 1 || urls[0] != "https://cdn.example.com/reference.png" {
		t.Fatalf("images should hold one url, got %#v", payload["images"])
	}
}

// 参考视频与参考音频应分别进入 videos / audios。
func TestBuildOpenAIVideoSubmissionBodyReferenceMedia(t *testing.T) {
	input := portllm.GenerateInput{
		Messages: []portllm.Message{{
			Role:    "user",
			Content: "一段产品广告",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "一段产品广告"},
				{Kind: portllm.ContentPartImage, URL: "https://cdn.example.com/reference.png"},
				{Kind: portllm.ContentPartVideo, URL: "https://cdn.example.com/reference.mp4"},
				{Kind: portllm.ContentPartAudio, URL: "https://cdn.example.com/reference.mp3"},
			},
		}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("sd2.0-720p-official", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	images, ok := payload["images"].([]string)
	if !ok || len(images) != 1 || images[0] != "https://cdn.example.com/reference.png" {
		t.Fatalf("unexpected images: %#v", payload["images"])
	}
	videos, ok := payload["videos"].([]string)
	if !ok || len(videos) != 1 || videos[0] != "https://cdn.example.com/reference.mp4" {
		t.Fatalf("unexpected videos: %#v", payload["videos"])
	}
	audios, ok := payload["audios"].([]string)
	if !ok || len(audios) != 1 || audios[0] != "https://cdn.example.com/reference.mp3" {
		t.Fatalf("unexpected audios: %#v", payload["audios"])
	}
}

// 参考素材只有字节、没有可访问 URL 时必须显式失败，不得静默丢弃素材。
func TestBuildOpenAIVideoSubmissionBodyRequiresMaterialURL(t *testing.T) {
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
	if _, _, err := buildOpenAIVideoSubmissionBody("minimax-h3", input); err == nil {
		t.Fatalf("expected reference material without url to fail")
	}
}

// 首尾帧模式把前两张参考图映射为 first_frame / last_frame 字符串 URL，并且不发送 images。
func TestBuildOpenAIVideoSubmissionBodyFirstLastFrame(t *testing.T) {
	input := portllm.GenerateInput{
		Options: map[string]any{"mode": portllm.OpenAIVideoModeFrames, "seconds": 8, "resolution_name": "720p", "ratio": "16:9"},
		Messages: []portllm.Message{{
			Role:    "user",
			Content: "首尾帧过渡",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "首尾帧过渡"},
				{Kind: portllm.ContentPartImage, URL: "https://cdn.example.com/first.png"},
				{Kind: portllm.ContentPartImage, URL: "https://cdn.example.com/last.png"},
			},
		}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("sd2.0-720p-official", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	if payload["mode"] != portllm.OpenAIVideoModeFrames {
		t.Fatalf("payload mode = %#v, want frames", payload["mode"])
	}
	for _, key := range []string{"image", "images"} {
		if _, exists := payload[key]; exists {
			t.Fatalf("first/last frame payload should not contain %s", key)
		}
	}
	if payload["first_frame"] != "https://cdn.example.com/first.png" {
		t.Fatalf("first_frame should be a url string, got %#v", payload["first_frame"])
	}
	if payload["last_frame"] != "https://cdn.example.com/last.png" {
		t.Fatalf("last_frame should be a url string, got %#v", payload["last_frame"])
	}
	if payload["seconds"] != 8 {
		t.Fatalf("seconds should be forwarded, got %#v", payload["seconds"])
	}
	if payload["size"] != "1280x720" {
		t.Fatalf("size should be derived from tier and ratio, got %#v", payload["size"])
	}
}

// 显式传入尺寸时应以显式值为准，不再按档位与比例换算。
func TestBuildOpenAIVideoSubmissionBodyExplicitSizeWins(t *testing.T) {
	input := portllm.GenerateInput{
		Options:  map[string]any{"resolution_name": "720p", "ratio": "16:9", "size": "1920x1080"},
		Messages: []portllm.Message{{Role: "user", Content: "一段产品广告"}},
	}
	payload, _, err := buildOpenAIVideoSubmissionBody("sd2.0-720p-official", input)
	if err != nil {
		t.Fatalf("build submission body: %v", err)
	}
	if payload["size"] != "1920x1080" {
		t.Fatalf("explicit size should win, got %#v", payload["size"])
	}
}

// 首尾帧模式携带参考视频时应拒绝，避免上游报错。
func TestBuildOpenAIVideoSubmissionBodyFirstLastFrameRejectsVideo(t *testing.T) {
	input := portllm.GenerateInput{
		Options: map[string]any{"mode": portllm.OpenAIVideoModeFrames},
		Messages: []portllm.Message{{
			Role:    "user",
			Content: "首尾帧过渡",
			Parts: []portllm.ContentPart{
				{Kind: portllm.ContentPartText, Text: "首尾帧过渡"},
				{Kind: portllm.ContentPartImage, URL: "https://cdn.example.com/first.png"},
				{Kind: portllm.ContentPartVideo, URL: "https://cdn.example.com/reference.mp4"},
			},
		}},
	}
	if _, _, err := buildOpenAIVideoSubmissionBody("sd2.0-720p-official", input); err == nil {
		t.Fatalf("expected first/last frame mode to reject reference video")
	}
}

// 提交响应只回传 task_id 时应能解析出任务编号。
func TestParseOpenAIVideoIDFallsBackToTaskID(t *testing.T) {
	videoID, err := parseOpenAIVideoID([]byte(`{"task_id":"upstream_385412","status":"in_progress"}`))
	if err != nil {
		t.Fatalf("parse video id: %v", err)
	}
	if videoID != "upstream_385412" {
		t.Fatalf("video id = %q, want upstream_385412", videoID)
	}
}

// 完成态只给出 output 数组时应能取回视频地址。
func TestParseOpenAIVideoResultFallsBackToOutput(t *testing.T) {
	body := []byte(`{"id":"task_1","status":"completed","output":[{"type":"video","url":"https://cdn.example.com/out.mp4"}]}`)
	output, pending, _, err := parseOpenAIVideoResult(body, "task_1", 0, "https://api.example.com/v1/videos/task_1/content")
	if err != nil {
		t.Fatalf("parse result: %v", err)
	}
	if pending {
		t.Fatalf("completed result should not be pending")
	}
	if len(output.GeneratedVideos) != 1 || output.GeneratedVideos[0].URL != "https://cdn.example.com/out.mp4" {
		t.Fatalf("unexpected generated videos: %#v", output.GeneratedVideos)
	}
}

// 每个上游状态各自映射：等待态保持 pending，取消态独立成错，未知态仍然报错。
func TestParseOpenAIVideoResultStatuses(t *testing.T) {
	const contentURL = "https://api.example.com/v1/videos/task_1/content"
	waiting := []string{"pending", "queued", "in_progress"}
	for _, status := range waiting {
		t.Run("waiting_"+status, func(t *testing.T) {
			output, pending, _, err := parseOpenAIVideoResult([]byte(`{"status":"`+status+`"}`), "task_1", 0, contentURL)
			if err != nil {
				t.Fatalf("waiting status %s should not error: %v", status, err)
			}
			if output != nil || !pending {
				t.Fatalf("waiting status %s should stay pending", status)
			}
		})
	}
	for _, status := range []string{"cancelled", "canceled"} {
		t.Run("cancelled_"+status, func(t *testing.T) {
			_, _, _, err := parseOpenAIVideoResult(
				[]byte(`{"status":"`+status+`","error":{"message":"用户已取消"}}`), "task_1", 0, contentURL,
			)
			if err == nil {
				t.Fatalf("cancelled status %s should fail", status)
			}
			if !isOpenAIVideoTaskFailedError(err) {
				t.Fatalf("cancelled status %s should be reported as a terminal task failure: %v", status, err)
			}
		})
	}
	t.Run("unknown", func(t *testing.T) {
		if _, _, _, err := parseOpenAIVideoResult([]byte(`{"status":"weird"}`), "task_1", 0, contentURL); err == nil {
			t.Fatalf("unknown status should fail")
		}
	})
}

// 进行中态上报的进度应能从结果体中解析出来，供轮询期间推送前端。
func TestParseOpenAIVideoResultReportsProgress(t *testing.T) {
	for _, testCase := range []struct {
		name string
		body string
		want int
	}{
		{name: "百分比整数", body: `{"status":"in_progress","progress":45}`, want: 45},
		{name: "百分比字符串", body: `{"status":"in_progress","progress":"45%"}`, want: 45},
		{name: "小数比例", body: `{"status":"in_progress","progress":0.45}`, want: 45},
		{name: "待处理态", body: `{"status":"pending"}`, want: -1},
		{name: "缺失进度", body: `{"status":"queued"}`, want: -1},
		{name: "越界进度封顶", body: `{"status":"in_progress","progress":180}`, want: 100},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			output, pending, progress, err := parseOpenAIVideoResult(
				[]byte(testCase.body), "task_1", 0, "https://api.example.com/v1/videos/task_1/content",
			)
			if err != nil {
				t.Fatalf("parse result: %v", err)
			}
			if output != nil || !pending {
				t.Fatalf("in-progress body should stay pending, got output=%#v pending=%v", output, pending)
			}
			if progress != testCase.want {
				t.Fatalf("progress = %d, want %d", progress, testCase.want)
			}
		})
	}
}
