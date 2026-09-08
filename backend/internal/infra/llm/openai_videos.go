package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	portllm "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

const (
	defaultOpenAIVideoPollInterval = time.Second
	// openAIVideoMaxPollDuration 是视频任务轮询的总兜底上限，实际取渠道读超时与该值中较小者。
	openAIVideoMaxPollDuration = 10 * time.Minute
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
	images := collectImageInputParts(input.Messages)
	if strings.TrimSpace(prompt) == "" {
		return nil, nil, fmt.Errorf("video generation prompt required")
	}
	if len(images) > 7 {
		return nil, nil, fmt.Errorf("too many video generation input images")
	}

	payload := map[string]any{
		"model":  strings.TrimSpace(model),
		"prompt": strings.TrimSpace(prompt),
	}
	// 图片优先用 URL 字符串（上游自行拉取，避免 base64 内联撑爆请求体）；
	// 无 URL 时单图回退 image 对象、多图回退 data URL 字符串数组。
	switch len(images) {
	case 0:
	case 1:
		if url := strings.TrimSpace(images[0].URL); url != "" {
			payload["image"] = url
		} else {
			payload["image"] = xAIVideoImagePayload(images[0])
		}
	default:
		urls := make([]string, 0, len(images))
		for _, image := range images {
			if url := strings.TrimSpace(image.URL); url != "" {
				urls = append(urls, url)
			} else {
				urls = append(urls, xAIVideoImageDataURL(image))
			}
		}
		payload["images"] = urls
	}
	applyOpenAIVideoParams(payload, input.Options)

	debugPayload := map[string]any{
		"model":       payload["model"],
		"prompt":      payload["prompt"],
		"image_count": len(images),
	}
	for _, key := range []string{"duration", "resolution", "aspect_ratio"} {
		if value, ok := payload[key]; ok {
			debugPayload[key] = value
		}
	}
	debugBody, _ := json.Marshal(debugPayload)
	return payload, debugBody, nil
}

func applyOpenAIVideoParams(payload map[string]any, options map[string]any) {
	normalized := make(map[string]any, len(options))
	for key, value := range options {
		normalized[key] = value
	}
	portllm.SanitizeOpenAIVideoOptions(normalized)
	for _, key := range []string{"aspect_ratio", "duration", "resolution"} {
		if value, ok := normalized[key]; ok {
			payload[key] = value
		}
	}
}

func parseOpenAIVideoID(body []byte) (string, error) {
	parsed := make(map[string]any)
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", err
	}
	videoID := strings.TrimSpace(getString(parsed["id"]))
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
		strings.HasPrefix(message, "openai video result was blocked")
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

func (c *Client) pollOpenAIVideoResult(ctx context.Context, route portllm.RouteConfig, videoID string, requestedDurationSeconds int64, onProgress func(percent int)) (*portllm.GenerateOutput, error) {
	requestURL := buildOpenAIVideoResultURL(route.BaseURL, videoID)
	if requestURL == "" {
		return nil, portllm.MarkRequestAccepted(fmt.Errorf("invalid openai video result url"))
	}
	contentURL := buildOpenAIVideoContentURL(route.BaseURL, videoID)
	lastProgress := -1
	transientFailures := 0
	perRequestTimeout := resolveReadTimeout(route.ReadTimeoutMS)

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
			if waitErr := waitXAIVideoPoll(ctx, defaultXAIVideoPollInterval); waitErr != nil {
				return nil, portllm.MarkRequestAccepted(waitErr)
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
				return nil, portllm.MarkRequestAccepted(waitErr)
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
				return nil, portllm.MarkRequestAccepted(waitErr)
			}
			continue
		}
		transientFailures = 0

		output, pending, progress, err := parseOpenAIVideoResult(body, videoID, requestedDurationSeconds, contentURL)
		if err != nil {
			return nil, acceptedOpenAIVideoResponseError(err, debug)
		}
		if pending && onProgress != nil && progress >= 0 && progress != lastProgress {
			lastProgress = progress
			onProgress(progress)
		}
		if !pending {
			output.Debug = debug
			return output, nil
		}
		if err := waitXAIVideoPoll(ctx, xAIVideoPollDelay(resp.Header.Get("Retry-After"))); err != nil {
			return nil, portllm.MarkRequestAccepted(err)
		}
	}
}

func parseOpenAIVideoResult(body []byte, videoID string, requestedDurationSeconds int64, contentURL string) (*portllm.GenerateOutput, bool, int, error) {
	parsed := make(map[string]any)
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, false, 0, err
	}
	status := strings.ToLower(strings.TrimSpace(getString(parsed["status"])))
	progress := toInt64(parsed["progress"])
	switch status {
	case "queued", "in_progress":
		return nil, true, int(progress), nil
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
		return nil, false, 0, fmt.Errorf("openai video generation failed: %s", message)
	case "completed":
	default:
		return nil, false, 0, fmt.Errorf("unexpected openai video status %q", status)
	}

	videoURL := strings.TrimSpace(getString(parsed["video_url"]))
	if videoURL == "" {
		videoURL = contentURL
	}
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
			FallbackURL:     contentURL,
			MIMEType:        "video/mp4",
			DurationSeconds: durationSeconds,
		}},
		RawJSON: string(body),
	}
	result.Usage.RawUsageJSON = rawUsageJSONFromPath(parsed, "usage")
	return result, false, 0, nil
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
