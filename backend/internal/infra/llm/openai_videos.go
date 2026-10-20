package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	portllm "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

const (
	defaultOpenAIVideoPollInterval = time.Second
	// openAIVideoMaxPollDuration 是视频任务轮询的总兜底上限，实际取渠道读超时与该值中较小者。
	openAIVideoMaxPollDuration = 10 * time.Minute
)

// 视频生成参考素材上限：与上游 Seedance 2.0 / 2.5 的引用规则对齐。
const (
	maxOpenAIVideoInputImages = 7
	maxOpenAIVideoInputVideos = 3
	maxOpenAIVideoInputAudios = 4
)

// openAIVideoAdapter 实现 Sora 兼容的异步视频生成协议（POST /v1/videos）。
type openAIVideoAdapter struct {
	client *Client
}

func (a *openAIVideoAdapter) Name() string { return portllm.AdapterOpenAIVideo }

func (a *openAIVideoAdapter) Generate(ctx context.Context, route portllm.RouteConfig, input portllm.GenerateInput) (*portllm.GenerateOutput, error) {
	route.Protocol = portllm.AdapterOpenAIVideo
	if input.VideoExtensionSource != nil {
		return nil, fmt.Errorf("openai video generation protocol does not accept an extension source")
	}
	route.Endpoint = portllm.EndpointVideoGenerations
	return a.client.generateOpenAIVideo(ctx, route, input)
}

func (a *openAIVideoAdapter) GenerateStream(
	context.Context,
	portllm.RouteConfig,
	portllm.GenerateInput,
	func(portllm.GenerateStreamEvent) error,
) (*portllm.GenerateOutput, error) {
	return nil, fmt.Errorf("%w: %s", portllm.ErrUnsupportedStream, portllm.AdapterOpenAIVideo)
}

func (a *openAIVideoAdapter) ListModels(ctx context.Context, route portllm.RouteConfig) ([]portllm.ModelItem, error) {
	route.Protocol = portllm.AdapterOpenAIVideo
	return a.client.listModelsOpenAICompatible(ctx, route)
}

// generateOpenAIVideo 提交视频任务，并在同一请求超时范围内轮询结果端点。
// 总超时取渠道读超时与 openAIVideoMaxPollDuration 中较小者。
func (c *Client) generateOpenAIVideo(ctx context.Context, route portllm.RouteConfig, input portllm.GenerateInput) (*portllm.GenerateOutput, error) {
	requestBody, debugBody, err := buildOpenAIVideoSubmissionBody(route.UpstreamModel, input)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(requestBody)
	if err != nil {
		return nil, err
	}
	requestURL := buildOpenAIVideosURL(route.BaseURL)
	if requestURL == "" {
		return nil, fmt.Errorf("invalid base url")
	}

	// 视频生成总预算固定 10 分钟；渠道读超时回归单次 HTTP 请求语义，
	// 否则 180s 量级的读超时会在轮询中期掐死仍在正常执行的长耗时任务。
	requestCtx, cancel := context.WithTimeout(ctx, openAIVideoMaxPollDuration)
	defer cancel()

	// 提交阶段对瞬时故障做有限重试：中转网关到上游的网络抖动（500/502/503/504）
	// 意味着任务尚未在上游创建，重试不会产生重复任务。
	var body []byte
	var debug *portllm.UpstreamDebugSnapshot
	const maxSubmitAttempts = 3
	for attempt := 1; ; attempt++ {
		req, err := newXAIMediaRequest(requestCtx, http.MethodPost, requestURL, payload, route)
		if err != nil {
			return nil, err
		}
		resp, err := c.doRouteGenerationRequest(route, req)
		if err != nil {
			if attempt < maxSubmitAttempts {
				if waitErr := waitXAIVideoPoll(requestCtx, time.Second); waitErr == nil {
					continue
				}
			}
			return nil, err
		}
		attemptBody, readErr := readUpstreamBody(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil, acceptedOpenAIVideoResponseError(readErr, upstreamDebugSnapshot(req, debugBody, resp, attemptBody))
			}
			return nil, readErr
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			body = attemptBody
			debug = upstreamDebugSnapshot(req, debugBody, resp, body)
			break
		}
		if isOpenAIVideoTransientStatus(resp.StatusCode) && attempt < maxSubmitAttempts {
			if waitErr := waitXAIVideoPoll(requestCtx, time.Second); waitErr == nil {
				continue
			}
		}
		return nil, parseUpstreamError(resp.StatusCode, attemptBody, upstreamDebugSnapshot(req, debugBody, resp, attemptBody))
	}

	videoID, err := parseOpenAIVideoID(body)
	if err != nil {
		return nil, acceptedOpenAIVideoResponseError(err, debug)
	}
	if input.OnTaskStarted != nil {
		input.OnTaskStarted(videoID)
	}
	return c.pollOpenAIVideoResult(requestCtx, route, videoID, generatedMediaDurationSeconds(requestBody["duration"]), input.OnProgress)
}

func buildOpenAIVideosURL(baseURL string) string {
	return buildVersionedEndpointURL(baseURL, "v1", "/videos")
}

func buildOpenAIVideoResultURL(baseURL string, videoID string) string {
	id := strings.TrimSpace(videoID)
	if id == "" {
		return ""
	}
	return buildVersionedEndpointURL(baseURL, "v1", "/videos/"+url.PathEscape(id))
}

func buildOpenAIVideoContentURL(baseURL string, videoID string) string {
	id := strings.TrimSpace(videoID)
	if id == "" {
		return ""
	}
	return buildVersionedEndpointURL(baseURL, "v1", "/videos/"+url.PathEscape(id)+"/content")
}

func buildOpenAIVideoSubmissionBody(model string, input portllm.GenerateInput) (map[string]any, []byte, error) {
	prompt := buildOpenAIImageGenerationPrompt(input.Messages)
	images := collectMediaInputParts(input.Messages, portllm.ContentPartImage)
	videos := collectMediaInputParts(input.Messages, portllm.ContentPartVideo)
	audios := collectMediaInputParts(input.Messages, portllm.ContentPartAudio)
	if strings.TrimSpace(prompt) == "" {
		return nil, nil, fmt.Errorf("video generation prompt required")
	}
	if len(images) > maxOpenAIVideoInputImages {
		return nil, nil, fmt.Errorf("too many video generation input images")
	}
	if len(videos) > maxOpenAIVideoInputVideos {
		return nil, nil, fmt.Errorf("too many video generation input videos")
	}
	if len(audios) > maxOpenAIVideoInputAudios {
		return nil, nil, fmt.Errorf("too many video generation input audios")
	}
	imageURLs, err := openAIVideoMaterialURLs(images)
	if err != nil {
		return nil, nil, err
	}
	videoURLs, err := openAIVideoMaterialURLs(videos)
	if err != nil {
		return nil, nil, err
	}
	audioURLs, err := openAIVideoMaterialURLs(audios)
	if err != nil {
		return nil, nil, err
	}

	mode := portllm.OpenAIVideoMode(input.Options)
	payload := map[string]any{
		"model":  strings.TrimSpace(model),
		"prompt": strings.TrimSpace(prompt),
		"mode":   mode,
	}
	if mode == portllm.OpenAIVideoModeFrames {
		// 首尾帧模式：前两张参考图分别作为首帧与尾帧；上游要求此时最多两张图且不能传参考视频，
		// 且首尾帧已由 first_frame / last_frame 表达，不再重复注入 images。
		if len(imageURLs) > 2 || len(videoURLs) > 0 {
			return nil, nil, fmt.Errorf("first/last frame mode accepts at most two images and no reference video")
		}
		if len(imageURLs) > 0 {
			payload["first_frame"] = imageURLs[0]
		}
		if len(imageURLs) > 1 {
			payload["last_frame"] = imageURLs[1]
		}
	} else if len(imageURLs) > 0 {
		payload["images"] = imageURLs
	}
	if len(videoURLs) > 0 {
		payload["videos"] = videoURLs
	}
	if len(audioURLs) > 0 {
		payload["audios"] = audioURLs
	}
	applyOpenAIVideoParams(payload, input.Options)

	debugPayload := map[string]any{
		"model":       payload["model"],
		"prompt":      payload["prompt"],
		"mode":        payload["mode"],
		"image_count": len(images),
		"video_count": len(videos),
		"audio_count": len(audios),
		"first_frame": payload["first_frame"] != nil,
		"last_frame":  payload["last_frame"] != nil,
	}
	for _, key := range []string{"seconds", "size", "resolution_name", "ratio", "generate_audio", "watermark"} {
		if value, ok := payload[key]; ok {
			debugPayload[key] = value
		}
	}
	debugBody, _ := json.Marshal(debugPayload)
	return payload, debugBody, nil
}

// collectMediaInputParts 按内容类型收集消息中的参考素材（图片 / 视频 / 音频）。
// 素材以签名 URL 形式交付上游，因此这里同时接受只有 URL 没有字节的片段。
func collectMediaInputParts(messages []portllm.Message, kind string) []portllm.ContentPart {
	parts := make([]portllm.ContentPart, 0)
	for _, msg := range messages {
		for _, part := range msg.Parts {
			if part.Kind != kind || (len(part.Data) == 0 && strings.TrimSpace(part.URL) == "") {
				continue
			}
			parts = append(parts, part)
		}
	}
	return parts
}

// openAIVideoMaterialURLs 取出参考素材的签名 URL，顺序保持上传顺序。
// 上游协议只接受可访问 URL；素材缺少地址时必须显式失败，不能退化为内联字节。
func openAIVideoMaterialURLs(parts []portllm.ContentPart) ([]string, error) {
	urls := make([]string, 0, len(parts))
	for _, part := range parts {
		materialURL := strings.TrimSpace(part.URL)
		if materialURL == "" {
			return nil, fmt.Errorf("video generation reference material requires an accessible url")
		}
		urls = append(urls, materialURL)
	}
	return urls, nil
}

// applyOpenAIVideoParams 上送收敛后的参数；size 未显式传入时按分辨率档位与画幅比例换算。
func applyOpenAIVideoParams(payload map[string]any, options map[string]any) {
	normalized := maps.Clone(options)
	portllm.SanitizeOpenAIVideoOptions(normalized)
	for _, key := range []string{"seconds", "resolution_name", "ratio", "size", "generate_audio", "watermark"} {
		if value, ok := normalized[key]; ok {
			payload[key] = value
		}
	}
	if _, ok := payload["size"]; ok {
		return
	}
	if size := portllm.OpenAIVideoSizeFromTierAndRatio(getString(normalized["resolution_name"]), getString(normalized["ratio"])); size != "" {
		payload["size"] = size
	}
}

func parseOpenAIVideoID(body []byte) (string, error) {
	parsed := make(map[string]any)
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", err
	}
	videoID := strings.TrimSpace(getString(parsed["id"]))
	if videoID == "" {
		// 部分中转站只回传上游任务号 task_id。
		videoID = strings.TrimSpace(getString(parsed["task_id"]))
	}
	if videoID == "" {
		return "", fmt.Errorf("openai video response missing id")
	}
	return videoID, nil
}

// isOpenAIVideoTaskFailedError 判断回查解析错误是否代表上游任务明确失败。
func isOpenAIVideoTaskFailedError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.HasPrefix(message, "openai video generation failed:") ||
		strings.HasPrefix(message, "openai video result was blocked") ||
		strings.HasPrefix(message, "openai video result was cancelled")
}

// maxOpenAIVideoTransientPollFailures 是轮询期间连续瞬时失败的重试上限：
// 网关抖动（502/504 等）不应把上游仍在正常执行的任务判死。
const maxOpenAIVideoTransientPollFailures = 15

// isOpenAIVideoTransientStatus 返回轮询响应中可退避重试的瞬时状态码。
// 4xx 业务错误（400/401/403 等）不在其列，应立即失败透传。
func isOpenAIVideoTransientStatus(statusCode int) bool {
	switch statusCode {
	case http.StatusRequestTimeout, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func (c *Client) pollOpenAIVideoResult(
	ctx context.Context,
	route portllm.RouteConfig,
	videoID string,
	requestedDurationSeconds int64,
	onProgress func(percent int),
) (*portllm.GenerateOutput, error) {
	requestURL := buildOpenAIVideoResultURL(route.BaseURL, videoID)
	if requestURL == "" {
		return nil, portllm.MarkRequestAccepted(fmt.Errorf("invalid openai video result url"))
	}
	contentURL := buildOpenAIVideoContentURL(route.BaseURL, videoID)
	transientFailures := 0
	perRequestTimeout := resolveReadTimeout(route.ReadTimeoutMS)
	// 上次已上报的进度：仅在数值变化时回调，避免轮询空转产生重复事件
	lastProgress := -1

	for {
		// 每次轮询单独计时；总预算由 requestCtx（10 分钟）与取消信号控制
		reqCtx, reqCancel := context.WithTimeout(ctx, perRequestTimeout)
		req, err := newXAIMediaRequest(reqCtx, http.MethodGet, requestURL, nil, route)
		if err != nil {
			reqCancel()
			return nil, portllm.MarkRequestAccepted(err)
		}
		resp, err := c.doRouteRequest(route, req)
		reqCancel()
		if err != nil {
			// 传输层抖动（连接重置、临时超时等）：退避后继续轮询
			if transientFailures++; transientFailures >= maxOpenAIVideoTransientPollFailures {
				return nil, portllm.MarkRequestAccepted(fmt.Errorf("openai video poll failed after %d consecutive transport errors: %w", transientFailures, err))
			}
			if waitErr := waitXAIVideoPoll(ctx, defaultOpenAIVideoPollInterval); waitErr != nil {
				return nil, portllm.MarkRequestAccepted(videoPollWaitError(waitErr, openAIVideoMaxPollDuration))
			}
			continue
		}
		body, readErr := readUpstreamBody(resp.Body)
		_ = resp.Body.Close()
		debug := upstreamDebugSnapshot(req, nil, resp, body)
		if readErr != nil {
			if transientFailures++; transientFailures >= maxOpenAIVideoTransientPollFailures {
				return nil, acceptedOpenAIVideoResponseError(readErr, debug)
			}
			if waitErr := waitXAIVideoPoll(ctx, xAIVideoPollDelay(resp.Header.Get("Retry-After"))); waitErr != nil {
				return nil, portllm.MarkRequestAccepted(videoPollWaitError(waitErr, openAIVideoMaxPollDuration))
			}
			continue
		}
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
			if !isOpenAIVideoTransientStatus(resp.StatusCode) {
				return nil, portllm.MarkRequestAccepted(parseUpstreamError(resp.StatusCode, body, debug))
			}
			// 上游网关瞬时故障：退避重试，连续失败超过上限才判失败
			if transientFailures++; transientFailures >= maxOpenAIVideoTransientPollFailures {
				return nil, portllm.MarkRequestAccepted(parseUpstreamError(resp.StatusCode, body, debug))
			}
			if waitErr := waitXAIVideoPoll(ctx, xAIVideoPollDelay(resp.Header.Get("Retry-After"))); waitErr != nil {
				return nil, portllm.MarkRequestAccepted(videoPollWaitError(waitErr, openAIVideoMaxPollDuration))
			}
			continue
		}
		transientFailures = 0

		output, pending, progress, err := parseOpenAIVideoResult(body, videoID, requestedDurationSeconds, contentURL)
		if err != nil {
			return nil, acceptedOpenAIVideoResponseError(err, debug)
		}
		if !pending {
			output.Debug = debug
			return output, nil
		}
		if onProgress != nil && progress >= 0 && progress != lastProgress {
			lastProgress = progress
			onProgress(progress)
		}
		if err := waitXAIVideoPoll(ctx, xAIVideoPollDelay(resp.Header.Get("Retry-After"))); err != nil {
			return nil, portllm.MarkRequestAccepted(videoPollWaitError(err, openAIVideoMaxPollDuration))
		}
	}
}

func parseOpenAIVideoResult(body []byte, videoID string, requestedDurationSeconds int64, contentURL string) (*portllm.GenerateOutput, bool, int, error) {
	parsed := make(map[string]any)
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, false, -1, err
	}
	status := strings.ToLower(strings.TrimSpace(getString(parsed["status"])))
	switch status {
	case "pending", "queued", "in_progress":
		// 尚未产出结果的三个等待态语义一致；进度字段缺失时返回 -1（未知）。
		return nil, true, openAIVideoProgressPercent(parsed), nil
	case "failed":
		errorPayload := asMap(parsed["error"])
		code := strings.TrimSpace(getString(errorPayload["code"]))
		message := strings.TrimSpace(getString(errorPayload["message"]))
		if message == "" {
			message = "openai video generation failed"
		}
		if code != "" {
			message = code + ": " + message
		}
		return nil, false, -1, fmt.Errorf("openai video generation failed: %s", message)
	case "cancelled", "canceled":
		message := strings.TrimSpace(getString(asMap(parsed["error"])["message"]))
		if message == "" {
			message = "openai video result was cancelled"
		}
		return nil, false, -1, fmt.Errorf("openai video result was cancelled: %s", message)
	case "completed":
	default:
		return nil, false, -1, fmt.Errorf("unexpected openai video status %q", status)
	}

	videoURL := openAIVideoResultURL(parsed, contentURL)
	durationSeconds := generatedMediaDurationSeconds(
		parsed["duration_seconds"],
		parsed["duration"],
		parsed["seconds"],
		requestedDurationSeconds,
	)
	result := &portllm.GenerateOutput{
		ResponseID:      strings.TrimSpace(videoID),
		ToolCalls:       make([]portllm.ToolCall, 0),
		ServerToolCalls: make([]portllm.ToolCall, 0),
		GeneratedVideos: []portllm.GeneratedVideo{{
			URL:             videoURL,
			MIMEType:        "video/mp4",
			DurationSeconds: durationSeconds,
		}},
		RawJSON: string(body),
	}
	result.Usage.RawUsageJSON = rawUsageJSONFromPath(parsed, "usage")
	return result, false, 100, nil
}

// openAIVideoProgressPercent 解析上游任务进度：返回 0-100 的整数百分比；
// 部分网关以 0-1 的小数上报，统一折算为百分比；字段缺失或非法时返回 -1（未知）。
func openAIVideoProgressPercent(parsed map[string]any) int {
	raw, ok := parsed["progress"]
	if !ok {
		return -1
	}
	var value float64
	switch typed := raw.(type) {
	case float64:
		value = typed
	case float32:
		value = float64(typed)
	case int:
		value = float64(typed)
	case int64:
		value = float64(typed)
	case json.Number:
		parsedValue, err := typed.Float64()
		if err != nil {
			return -1
		}
		value = parsedValue
	case string:
		parsedValue, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(typed), "%"), 64)
		if err != nil {
			return -1
		}
		value = parsedValue
	default:
		return -1
	}
	if value <= 0 {
		return -1
	}
	// 0-1 的小数按比例折算；整数百分比保持原值
	if value < 1 {
		value *= 100
	}
	percent := int(math.Round(value))
	if percent > 100 {
		percent = 100
	}
	return percent
}

// openAIVideoResultURL 按中转站与官方字段的常见形态依次回退取回视频地址：
// 顶层 video_url / url、output 数组中的视频项、result 对象的 video_url / url，
// 全部缺失时回退到官方的 /v1/videos/{id}/content 端点。
func openAIVideoResultURL(parsed map[string]any, contentURL string) string {
	for _, key := range []string{"video_url", "url"} {
		if value := strings.TrimSpace(getString(parsed[key])); value != "" {
			return value
		}
	}
	if value := openAIVideoOutputURL(parsed["output"]); value != "" {
		return value
	}
	result := asMap(parsed["result"])
	for _, key := range []string{"video_url", "url"} {
		if value := strings.TrimSpace(getString(result[key])); value != "" {
			return value
		}
	}
	return contentURL
}

// openAIVideoOutputURL 从 output 结果数组中取出视频地址。
func openAIVideoOutputURL(output any) string {
	items, ok := output.([]any)
	if !ok {
		return ""
	}
	for _, item := range items {
		payload := asMap(item)
		url := strings.TrimSpace(getString(payload["url"]))
		if url == "" {
			continue
		}
		if kind := strings.ToLower(strings.TrimSpace(getString(payload["type"]))); kind == "" || kind == "video" {
			return url
		}
	}
	return ""
}

func acceptedOpenAIVideoResponseError(err error, debug *portllm.UpstreamDebugSnapshot) error {
	if err == nil {
		return nil
	}
	body := ""
	if debug != nil {
		body = debug.Response.Body
	}
	return portllm.MarkRequestAccepted(&portllm.UpstreamError{
		StatusCode: http.StatusBadGateway,
		Message:    strings.TrimSpace(err.Error()),
		Body:       body,
		Debug:      debug,
	})
}
