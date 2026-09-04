package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// imageEditsJSONAdapter 适配 JSON 体风格的图片编辑接口（如 SenseNova）：
// 路径与 OpenAI 相同（/v1/images/edits），但请求为 JSON 体，
// 参考图通过 images[].image_url 传入（支持公网 URL 或 Base64 Data-URL），为同步接口。
type imageEditsJSONAdapter struct {
	client *Client
}

func (a *imageEditsJSONAdapter) Name() string { return AdapterImageEditsJSON }

// Generate 调用 JSON 体图片编辑接口，返回结构化图片结果。
func (a *imageEditsJSONAdapter) Generate(ctx context.Context, route RouteConfig, input GenerateInput) (*GenerateOutput, error) {
	return a.client.generateImageEditsJSON(ctx, route, input)
}

// GenerateStream：JSON 编辑接口为同步调用，不支持流式。
func (a *imageEditsJSONAdapter) GenerateStream(
	ctx context.Context,
	route RouteConfig,
	input GenerateInput,
	onEvent func(GenerateStreamEvent) error,
) (*GenerateOutput, error) {
	return nil, fmt.Errorf("%w: %s", ErrUnsupportedStream, AdapterImageEditsJSON)
}

// ListModels 复用 OpenAI 兼容 models 目录，供渠道校验和展示使用。
func (a *imageEditsJSONAdapter) ListModels(ctx context.Context, route RouteConfig) ([]ModelItem, error) {
	return a.client.listModelsOpenAICompatible(ctx, route)
}

// generateImageEditsJSON 构造并执行 JSON 图片编辑请求。
func (c *Client) generateImageEditsJSON(ctx context.Context, route RouteConfig, input GenerateInput) (*GenerateOutput, error) {
	requestURL := buildOpenAIRequestURL(route.BaseURL, EndpointImageEdits)
	if requestURL == "" {
		return nil, fmt.Errorf("invalid base url")
	}

	payload, debugBody, err := buildImageEditsJSONRequestBody(route.UpstreamModel, input)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	requestCtx, cancel := context.WithTimeout(ctx, resolveReadTimeout(route.ReadTimeoutMS))
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, requestURL, strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey := strings.TrimSpace(route.APIKey); apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	setAdditionalHeaders(req, route.HeadersJSON)

	resp, err := c.doRouteRequest(route, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck

	body, err := readUpstreamBody(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, parseUpstreamError(resp.StatusCode, body, upstreamDebugSnapshot(req, debugBody, resp, body))
	}

	return parseOpenAIImageOutput(body, modelParamString(input.Options, "output_format"))
}

// buildImageEditsJSONRequestBody 构造 JSON 编辑请求 JSON 体。
// 参考图转为 Base64 Data-URL（纯无前缀 Base64 不被上游接受）；
// n 上游仅支持 1，由调用方按次发起任务，这里不传。
func buildImageEditsJSONRequestBody(model string, input GenerateInput) (map[string]interface{}, []byte, error) {
	prompt := buildOpenAIImageGenerationPrompt(input.Messages)
	if strings.TrimSpace(prompt) == "" {
		return nil, nil, fmt.Errorf("image edit prompt required")
	}
	images := collectImageInputParts(input.Messages)
	if len(images) == 0 {
		return nil, nil, fmt.Errorf("image edit input image required")
	}

	imageEntries := make([]map[string]string, 0, len(images))
	for _, image := range images {
		mimeType := strings.TrimSpace(image.MimeType)
		if mimeType == "" {
			mimeType = "image/png"
		}
		dataURL := fmt.Sprintf("data:%s;base64,%s", mimeType, base64.StdEncoding.EncodeToString(image.Data))
		imageEntries = append(imageEntries, map[string]string{"image_url": dataURL})
	}

	payload := map[string]interface{}{
		"model":  strings.TrimSpace(model),
		"images": imageEntries,
		"prompt": prompt,
	}
	options := input.Options
	if value := modelParamString(options, "size"); value != "" {
		payload["size"] = value
	}
	if value := modelParamString(options, "response_format"); value != "" {
		payload["response_format"] = value
	}
	if value, ok := modelParamBoolValue(options, "watermark"); ok {
		payload["watermark"] = value
	}
	if value, ok := modelParamBoolValue(options, "prompt_extend"); ok {
		payload["prompt_extend"] = value
	}

	// 调试快照：不携带图片二进制，仅记录图片数量与关键参数
	debugPayload := map[string]interface{}{
		"image_count": len(imageEntries),
		"mask":        input.ImageEditMask != nil && len(input.ImageEditMask.Data) > 0,
		"model":       payload["model"],
		"prompt":      prompt,
	}
	debugRaw, err := json.Marshal(debugPayload)
	if err != nil {
		debugRaw = []byte(`{"json":true}`)
	}
	return payload, debugRaw, nil
}
