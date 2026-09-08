package conversation

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/textutil"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/background"
	"go.uber.org/zap"
)

const (
	defaultXAIVideoDurationSeconds    int64 = 6
	defaultOpenAIVideoDurationSeconds int64 = 5
	mediaCancellationFinalizeTimeout        = 5 * time.Second
)

type canceledMediaGenerationInput struct {
	Context             context.Context
	Conversation        *model.Conversation
	UserMessage         *model.Message
	AssistantMessage    *model.Message
	ReuseUserMessage    bool
	Route               channel.ResolvedRoute
	EffectiveOptions    map[string]any
	GenerateInput       llm.GenerateInput
	StartedAt           time.Time
	DurationSeconds     int64
	Billable            bool
	MetadataRefreshHint string
}

// failedMediaBillingResultInput 描述媒体上游成功后本地处理失败时需要保留的结果信息。
type failedMediaBillingResultInput struct {
	UserMessage      *model.Message
	AssistantMessage *model.Message
	Route            channel.ResolvedRoute
	EffectiveOptions map[string]any
	Usage            llm.Usage
	StartedAt        time.Time
	DurationSeconds  int64
	Failure          error
	Billable         bool
}

// buildFailedMediaBillingResult 保留上游成功后发生本地处理错误时的真实用量上下文。
func buildFailedMediaBillingResult(input failedMediaBillingResultInput) *SendMessageResult {
	if input.UserMessage == nil || input.AssistantMessage == nil {
		return nil
	}
	userMessage := *input.UserMessage
	assistantMessage := *input.AssistantMessage
	if assistantMessage.SourceMessageID != nil {
		assistantMessage.InputTokens = input.Usage.InputTokens
		assistantMessage.CacheReadTokens = input.Usage.CacheReadTokens
		assistantMessage.CacheWriteTokens = input.Usage.CacheWriteTokens
	} else {
		userMessage.InputTokens = input.Usage.InputTokens
		userMessage.CacheReadTokens = input.Usage.CacheReadTokens
		userMessage.CacheWriteTokens = input.Usage.CacheWriteTokens
		userMessage.TokenUsage = input.Usage.InputTokens + input.Usage.CacheReadTokens + input.Usage.CacheWriteTokens
	}
	assistantMessage.OutputTokens = input.Usage.OutputTokens
	assistantMessage.ReasoningTokens = input.Usage.ReasoningTokens
	assistantMessage.TokenUsage = assistantMessage.InputTokens + assistantMessage.CacheReadTokens + assistantMessage.CacheWriteTokens + assistantMessage.OutputTokens + assistantMessage.ReasoningTokens
	assistantMessage.LatencyMS = time.Since(input.StartedAt).Milliseconds()
	if assistantMessage.LatencyMS < 0 {
		assistantMessage.LatencyMS = 0
	}
	assistantMessage.Status = "error"
	if errors.Is(input.Failure, ErrMessageGenerationCanceled) {
		assistantMessage.Status = "canceled"
	}
	assistantMessage.ErrorCode = classifyRunErrorCode(input.Failure)
	assistantMessage.ErrorMessage = textutil.TruncateTrimmed(messageErrorSummary(input.Failure), 255)

	return &SendMessageResult{
		UserMessage:        userMessage,
		AssistantMessage:   assistantMessage,
		Billable:           input.Billable,
		UpstreamID:         input.Route.UpstreamID,
		UpstreamName:       input.Route.UpstreamName,
		PlatformModelName:  input.Route.PlatformModelName,
		RoutedBindingCode:  input.Route.BindingCode,
		UpstreamModelName:  input.Route.UpstreamModel,
		UpstreamProtocol:   input.Route.Protocol,
		EffectiveOptions:   input.EffectiveOptions,
		UsageSpeed:         input.Usage.Speed,
		UsageServiceTier:   input.Usage.ServiceTier,
		RawUsageJSON:       input.Usage.RawUsageJSON,
		CacheWrite5mTokens: input.Usage.CacheWrite5mTokens,
		CacheWrite1hTokens: input.Usage.CacheWrite1hTokens,
		LatencyMS:          assistantMessage.LatencyMS,
		DurationSeconds:    input.DurationSeconds,
		StartedAt:          input.StartedAt,
	}
}

func (s *Service) completeCanceledMediaGeneration(input canceledMediaGenerationInput) (*SendMessageResult, error) {
	if input.Context == nil || input.UserMessage == nil || input.AssistantMessage == nil {
		return nil, ErrMessageGenerationCanceled
	}
	persistCtx, cancel := background.WithTimeout(input.Context, mediaCancellationFinalizeTimeout)
	defer cancel()
	latencyMS := time.Since(input.StartedAt).Milliseconds()
	if latencyMS < 0 {
		latencyMS = 0
	}
	inputTokens := estimateGenerateInputTokens(input.GenerateInput)
	errorCode := classifyRunErrorCode(ErrMessageGenerationCanceled)
	errorMessage := textutil.TruncateTrimmed(ErrMessageGenerationCanceled.Error(), 255)

	if input.ReuseUserMessage {
		if err := s.repo.CompleteAssistantMessageWithGeneratedAttachments(
			persistCtx,
			input.AssistantMessage.ID,
			repository.AssistantMessageCompletionUpdate{
				ContentType:  input.AssistantMessage.ContentType,
				Content:      "",
				InputTokens:  inputTokens,
				LatencyMS:    latencyMS,
				Status:       "canceled",
				ErrorCode:    errorCode,
				ErrorMessage: errorMessage,
			},
			nil,
		); err != nil {
			return nil, err
		}
		input.AssistantMessage.InputTokens = inputTokens
		input.AssistantMessage.TokenUsage = inputTokens
	} else {
		if err := s.repo.CompleteAssistantMessageWithAttachments(
			persistCtx,
			input.UserMessage.ID,
			repository.MessageUsageUpdate{InputTokens: inputTokens},
			input.AssistantMessage.ID,
			repository.AssistantMessageCompletionUpdate{
				ContentType:  input.AssistantMessage.ContentType,
				Content:      "",
				LatencyMS:    latencyMS,
				Status:       "canceled",
				ErrorCode:    errorCode,
				ErrorMessage: errorMessage,
			},
			nil,
		); err != nil {
			return nil, err
		}
		input.UserMessage.InputTokens = inputTokens
		input.UserMessage.TokenUsage = inputTokens
	}

	input.AssistantMessage.Content = ""
	input.AssistantMessage.LatencyMS = latencyMS
	input.AssistantMessage.Status = "canceled"
	input.AssistantMessage.ErrorCode = errorCode
	input.AssistantMessage.ErrorMessage = errorMessage

	if input.MetadataRefreshHint == "" && input.Conversation != nil {
		input.MetadataRefreshHint = s.resolveConversationMetadataRefreshHint(persistCtx, *input.Conversation, *input.UserMessage)
	}
	return &SendMessageResult{
		UserMessage:         *input.UserMessage,
		AssistantMessage:    *input.AssistantMessage,
		MetadataRefreshHint: input.MetadataRefreshHint,
		Billable:            input.Billable,
		UpstreamID:          input.Route.UpstreamID,
		UpstreamName:        input.Route.UpstreamName,
		PlatformModelName:   input.Route.PlatformModelName,
		RoutedBindingCode:   input.Route.BindingCode,
		UpstreamModelName:   input.Route.UpstreamModel,
		UpstreamProtocol:    input.Route.Protocol,
		EffectiveOptions:    input.EffectiveOptions,
		LatencyMS:           latencyMS,
		DurationSeconds:     input.DurationSeconds,
		StartedAt:           input.StartedAt,
	}, nil
}

func (s *Service) isCanceledMediaGeneration(ctx context.Context, runID string, err error) bool {
	return errors.Is(ctx.Err(), context.Canceled) ||
		s.isMessageGenerationCanceled(ctx, runID) ||
		isMessageGenerationCanceledError(err)
}

// applyMediaRunUsage 将可计费媒体结果同步到运行日志。
func applyMediaRunUsage(run *model.Run, result *SendMessageResult) {
	if run == nil || result == nil {
		return
	}
	run.InputTokens = sendMessageBillingInputTokens(result)
	run.CacheReadTokens = sendMessageBillingCacheReadTokens(result)
	run.CacheWriteTokens = sendMessageBillingCacheWriteTokens(result)
	run.OutputTokens = result.AssistantMessage.OutputTokens
	run.ReasoningTokens = result.AssistantMessage.ReasoningTokens
}

func mediaDurationSecondsFromOptions(options map[string]any) int64 {
	paths := [][]string{
		{"durationSeconds"},
		{"duration_seconds"},
		{"duration"},
		{"videoConfig", "durationSeconds"},
		{"video_config", "duration_seconds"},
		{"generationConfig", "videoConfig", "durationSeconds"},
		{"generation_config", "video_config", "duration_seconds"},
	}
	for _, path := range paths {
		value, ok := readModelOptionPath(options, path)
		if !ok {
			continue
		}
		if seconds := mediaDurationSecondsFromValue(value); seconds > 0 {
			return seconds
		}
	}
	return 0
}

// logVideoDurationOptionDelta 在用户显式请求的时长未能原样生效时记录诊断日志。
// 同时解析参数策略与模型能力配置，直接判定覆盖来源：
// 模型能力 lockedOptionPaths 锁定、能力 defaultOptions 默认值、白名单未放行 duration、
// sanitize 范围拦截或别名键归一。日志只包含参数键与配置判定结果，不含提示词等用户内容。
func (s *Service) logVideoDurationOptionDelta(
	ctx context.Context,
	run *model.Run,
	userOptions map[string]any,
	effectiveOptions map[string]any,
	effectiveDuration int64,
	route channel.ResolvedRoute,
) {
	if s == nil || s.logger == nil {
		return
	}
	requestedDuration := mediaDurationSecondsFromOptions(userOptions)
	if requestedDuration <= 0 || requestedDuration == effectiveDuration {
		return
	}
	cfg := config.Config{}
	if s.cfg != nil {
		cfg = s.cfg.Snapshot()
	}
	fields := []zap.Field{
		zap.String("error_code", "media.duration_option_overridden"),
		zap.Int64("requested_duration_seconds", requestedDuration),
		zap.Int64("effective_duration_seconds", effectiveDuration),
		zap.Strings("requested_duration_keys", durationOptionKeys(userOptions)),
		zap.Strings("effective_duration_keys", durationOptionKeys(effectiveOptions)),
		zap.String("option_policy_mode", strings.TrimSpace(cfg.ModelOptionPolicyMode)),
		zap.String("override_source", classifyDurationOverrideSource(userOptions, effectiveDuration, route, cfg)),
	}
	if run != nil {
		fields = append(fields,
			zap.String("request_id", strings.TrimSpace(run.RequestID)),
			zap.String("run_id", strings.TrimSpace(run.RunID)),
			zap.Uint("conversation_id", run.ConversationID),
			zap.Uint("user_id", run.UserID),
			zap.Uint("upstream_id", run.UpstreamID),
			zap.Uint("upstream_model_id", run.UpstreamModelID),
			zap.String("provider_protocol", strings.TrimSpace(run.ProviderProtocol)),
			zap.String("platform_model_name", strings.TrimSpace(run.PlatformModelName)),
		)
	}
	s.logger.Warn("video_duration_option_overridden", fields...)
}

// classifyDurationOverrideSource 判定用户时长参数被覆盖的具体环节。
func classifyDurationOverrideSource(
	userOptions map[string]any,
	effectiveDuration int64,
	route channel.ResolvedRoute,
	cfg config.Config,
) string {
	protocol := strings.TrimSpace(route.Protocol)
	capabilitiesJSON := strings.TrimSpace(route.ModelCapabilitiesJSON)
	// 1. 模型能力锁定路径：默认值强制回写，优先级最高。
	if capabilitiesJSON != "" {
		for _, path := range modelCapabilityLockedOptionPaths(capabilitiesJSON) {
			if strings.EqualFold(strings.Join(path, "."), "duration") {
				return "model_capabilities.locked_option_paths"
			}
		}
	}
	// 2. 白名单未放行 duration：参数在过滤阶段被整体丢弃（仅当兜底与管理员白名单都未包含时）。
	if mode := strings.TrimSpace(cfg.ModelOptionPolicyMode); mode == "" || mode == modelOptionPolicyAllowlist {
		allowed := false
		for _, path := range mediaOptionBaselinePathsFor(modelOptionPolicyProtocolKey(protocol)) {
			if strings.EqualFold(strings.Join(path, "."), "duration") {
				allowed = true
				break
			}
		}
		if !allowed {
			for _, path := range modelOptionPathsForProtocol(cfg.ModelOptionAllowedPaths, protocol) {
				if strings.EqualFold(strings.Join(path, "."), "duration") {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			return "option_policy.allowed_paths_missing_duration"
		}
	}
	// 3. sanitize 范围拦截：请求值超出协议合法区间（openai/xai 视频 1-15 秒）。
	if requested := mediaDurationSecondsFromOptions(userOptions); requested < 1 || requested > 15 {
		return "sanitize.duration_out_of_range"
	}
	// 4. 其余情况：能力默认值合并或别名归一所致。
	if capabilitiesJSON != "" && modelCapabilityDefaultOptions(capabilitiesJSON)["duration"] != nil {
		return "model_capabilities.default_options"
	}
	return "option_policy.other"
}

// durationOptionKeys 收集 options 中与时长相关的键（含嵌套别名路径），供诊断定位参数来源。
func durationOptionKeys(options map[string]any) []string {
	if len(options) == 0 {
		return nil
	}
	paths := [][]string{
		{"durationSeconds"},
		{"duration_seconds"},
		{"duration"},
		{"seconds"},
		{"videoConfig", "durationSeconds"},
		{"video_config", "duration_seconds"},
		{"generationConfig", "videoConfig", "durationSeconds"},
		{"generation_config", "video_config", "duration_seconds"},
	}
	keys := make([]string, 0, len(paths))
	for _, path := range paths {
		if _, ok := readModelOptionPath(options, path); ok {
			keys = append(keys, strings.Join(path, "."))
		}
	}
	return keys
}

// withDefaultMediaVideoDuration 仅向明确支持 duration 参数的视频协议补齐产品缺省值。
// 其他协议仍以其返回的真实媒体时长为准，避免发送未声明的厂商参数。
func withDefaultMediaVideoDuration(options map[string]any, protocol string) map[string]any {
	adapter := llm.NormalizeAdapter(protocol)
	defaultDuration := int64(0)
	switch adapter {
	case llm.AdapterXAIVideo, llm.AdapterXAIVideoExtensions:
		defaultDuration = defaultXAIVideoDurationSeconds
	case llm.AdapterOpenAIVideo:
		defaultDuration = defaultOpenAIVideoDurationSeconds
	}
	if mediaDurationSecondsFromOptions(options) > 0 || defaultDuration == 0 {
		return options
	}
	next := make(map[string]any, len(options)+1)
	for key, value := range options {
		next[key] = value
	}
	next["duration"] = defaultDuration
	return next
}

func resolveGeneratedVideoDurations(videos []llm.GeneratedVideo, fallbackSeconds int64) ([]int64, int64) {
	durations := make([]int64, len(videos))
	var total int64
	for index, video := range videos {
		seconds := positiveSeconds(video.DurationSeconds)
		if seconds == 0 {
			seconds = positiveSeconds(fallbackSeconds)
		}
		durations[index] = seconds
		total += seconds
	}
	return durations, total
}

func mediaDurationSecondsFromValue(value any) int64 {
	switch v := value.(type) {
	case int:
		return positiveSeconds(int64(v))
	case int64:
		return positiveSeconds(v)
	case float64:
		return ceilPositiveSeconds(v)
	case float32:
		return ceilPositiveSeconds(float64(v))
	case string:
		text := strings.TrimSpace(strings.ToLower(v))
		text = strings.TrimSuffix(text, "seconds")
		text = strings.TrimSuffix(text, "second")
		text = strings.TrimSuffix(text, "secs")
		text = strings.TrimSuffix(text, "sec")
		text = strings.TrimSuffix(text, "s")
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return 0
		}
		return ceilPositiveSeconds(parsed)
	default:
		return 0
	}
}

func ceilPositiveSeconds(value float64) int64 {
	if value <= 0 {
		return 0
	}
	seconds := int64(value)
	if float64(seconds) < value {
		seconds++
	}
	return seconds
}

func positiveSeconds(value int64) int64 {
	if value <= 0 {
		return 0
	}
	return value
}
