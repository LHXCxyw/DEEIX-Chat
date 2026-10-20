package conversation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	appcm "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/contentmoderation"
	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	domainbilling "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/billing"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/textutil"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/traceid"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/background"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/tokenestimate"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// 视频生成参考素材上限：图片 7 张、参考视频 3 个、参考音频 4 个（对齐上游引用规则）。
const (
	maxMediaVideoInputImages = 7
	maxMediaVideoInputVideos = 3
	maxMediaVideoInputAudios = 4
)

// MediaVideoTaskType 区分普通视频生成与基于源视频的扩展。
type MediaVideoTaskType string

const (
	MediaVideoTaskGeneration MediaVideoTaskType = "video_generation"
	MediaVideoTaskExtension  MediaVideoTaskType = "video_extension"
)

// MediaVideoInput 定义视频生成任务的应用层入参。
type MediaVideoInput struct {
	UserID                uint
	ConversationID        uint
	RequestID             string
	TaskType              MediaVideoTaskType
	Prompt                string
	PlatformModelName     string
	Options               map[string]any
	ClientRunID           string
	FileIDs               []string
	ParentMessagePublicID string
	SourceMessagePublicID string
	BranchReason          string
	// UsageAuthorization 是请求级计费授权；路由确定后据此把预算预留抬高到按时长预估成本。
	UsageAuthorization *domainbilling.UsageAuthorization
	OnEvent            func(eventType string, payload map[string]any) error
}

// StreamMediaVideo 执行视频生成任务并把结果保存为文件对象。
func (s *Service) StreamMediaVideo(ctx context.Context, input MediaVideoInput) (result *SendMessageResult, retErr error) {
	if s.routeResolver == nil || s.llmClient == nil {
		return nil, ErrModelRouteNotConfigured
	}
	runID := normalizeRunID(input.ClientRunID)
	if runID == "" {
		runID = "run_" + normalizePublicID(uuid.NewString())
	}
	startedAt := time.Now()
	conversation, err := s.repo.GetConversationByUser(ctx, input.ConversationID, input.UserID)
	if err != nil {
		return nil, ErrConversationNotFound
	}

	normalizedBranchReason := normalizeBranchReason(input.BranchReason)
	branchState, err := s.resolveMessageBranch(ctx, input.ConversationID, input.UserID, input.ParentMessagePublicID, input.SourceMessagePublicID, normalizedBranchReason)
	if err != nil {
		return nil, err
	}
	reuseUserMessage := branchState.ReuseUserMessage != nil
	if reuseUserMessage {
		input.Prompt = branchState.ReuseUserMessage.Content
		input.FileIDs = parseAttachmentSnapshotFileIDs(branchState.ReuseUserMessage.Attachments)
	}
	if strings.TrimSpace(input.Prompt) == "" {
		return nil, ErrMediaVideoPromptRequired
	}
	taskType := normalizeMediaVideoTaskType(input.TaskType)
	routeTaskType := channel.TaskTypeVideoGeneration
	if taskType == MediaVideoTaskExtension {
		routeTaskType = channel.TaskTypeVideoExtension
	}

	platformModelName := strings.TrimSpace(input.PlatformModelName)
	if platformModelName == "" {
		platformModelName = strings.TrimSpace(conversation.Model)
	}
	if platformModelName == "" {
		return nil, ErrModelRouteNotConfigured
	}
	videoEndpoint := llm.EndpointVideoGenerations
	if taskType == MediaVideoTaskExtension {
		videoEndpoint = llm.EndpointVideoExtensions
	}
	run := &model.Run{
		RunID:              runID,
		RequestID:          strings.TrimSpace(input.RequestID),
		UserID:             input.UserID,
		ConversationID:     input.ConversationID,
		TaskType:           routeTaskType,
		Endpoint:           videoEndpoint,
		Provider:           strings.TrimSpace(conversation.Provider),
		RequestedModelName: platformModelName,
		Status:             "running",
		StartedAt:          startedAt,
	}
	if err = s.claimConversationRun(ctx, run); err != nil {
		return nil, err
	}
	var moderationCoord *appcm.RunCoordinator
	var userMessage *model.Message
	var assistantMessage *model.Message
	defer func() {
		if retErr != nil && moderationCoord != nil {
			if result == nil && userMessage != nil && assistantMessage != nil {
				result = &SendMessageResult{
					UserMessage:      *userMessage,
					AssistantMessage: *assistantMessage,
					Billable:         false,
					StartedAt:        startedAt,
				}
			}
			moderationCtx, cancelModeration := background.WithTimeout(ctx, moderationFinalizationTimeout)
			s.completeModerationAfterFailure(moderationCtx, moderationCoord, result)
			cancelModeration()
		}
		endedAt := time.Now()
		run.EndedAt = &endedAt
		run.TotalLatencyMS = endedAt.Sub(startedAt).Milliseconds()
		switch {
		case result != nil && result.IsModerationBlocked():
			applyBlockedRunFields(run, result)
		case retErr == nil:
			run.Status = "success"
			if result != nil {
				applyModerationRunState(run, result)
			}
		case errors.Is(retErr, ErrMessageGenerationCanceled):
			run.Status = "canceled"
			run.ErrorCode = classifyRunErrorCode(retErr)
			run.ErrorMessage = textutil.TruncateTrimmed(messageErrorSummary(retErr), 255)
			if result != nil {
				applyModerationRunState(run, result)
			}
		default:
			run.Status = "error"
			run.ErrorCode = classifyRunErrorCode(retErr)
			run.ErrorMessage = textutil.TruncateTrimmed(messageErrorSummary(retErr), 255)
			if result != nil {
				applyModerationRunState(run, result)
			}
		}
		persistCtx, cancelPersist := background.WithTimeout(ctx, 5*time.Second)
		defer cancelPersist()
		if err := s.repo.UpdateConversationRun(persistCtx, run); err != nil && s.logger != nil {
			s.logger.Error("update_video_conversation_run_failed",
				zap.String("trace_id", traceid.FromContext(ctx)),
				zap.String("run_id", run.RunID),
				zap.Error(err),
			)
		}
	}()
	cancelCtx, cancel := context.WithCancel(ctx)
	ctx = cancelCtx
	if err = s.registerDeletionSafeGeneration(ctx, runID, input.UserID, conversation.PublicID, cancel); err != nil {
		return nil, err
	}

	route, err := s.routeResolver.ResolveRoute(ctx, channel.ResolveRouteInput{
		PlatformModelName: platformModelName,
		TaskType:          routeTaskType,
		Scope:             channel.RouteScopeUser,
		UserID:            input.UserID,
		ConversationID:    input.ConversationID,
		RequestID:         strings.TrimSpace(input.RequestID),
	})
	if err != nil {
		return nil, mapRouteResolutionError(err)
	}
	if !llm.IsVideoGenerationAdapter(route.Protocol) {
		return nil, ErrMediaRouteProtocolMismatch
	}
	if taskType == MediaVideoTaskExtension && llm.NormalizeAdapter(route.Protocol) != llm.AdapterXAIVideoExtensions {
		return nil, ErrMediaRouteProtocolMismatch
	}
	videoEndpoint = llm.DefaultEndpointForAdapter(route.Protocol)
	run.Endpoint = videoEndpoint
	run.ProviderProtocol = route.Protocol
	run.UpstreamID = route.UpstreamID
	run.UpstreamModelID = route.UpstreamModelID
	run.UpstreamName = route.UpstreamName
	run.PlatformModelName = route.PlatformModelName
	run.RoutedBindingCode = route.BindingCode
	run.ModelVendor = route.ModelVendor
	run.ModelIcon = route.ModelIcon
	run.UpstreamModelName = route.UpstreamModel
	if err = s.ensureUsageBudgetCoversEstimate(ctx, input.UsageAuthorization, route, input.Options, usageBudgetEstimate{
		CallCount:       1,
		DurationSeconds: mediaDurationSecondsFromOptions(withDefaultMediaVideoDuration(input.Options, route.Protocol)),
	}); err != nil {
		return nil, err
	}
	if strings.TrimSpace(conversation.Model) != strings.TrimSpace(route.PlatformModelName) {
		conversation.Model = strings.TrimSpace(route.PlatformModelName)
		conversation.Provider = inferProvider(conversation.Model)
		run.Provider = conversation.Provider
		if err = s.repo.UpdateConversationModel(ctx, input.ConversationID, conversation.Model, conversation.Provider); err != nil {
			return nil, err
		}
	}
	resolvedAttachments, videoInputParts, videoExtensionSource, err := s.resolveMediaVideoInputs(ctx, input, taskType)
	if err != nil {
		return nil, err
	}
	attachmentsJSON := marshalAttachmentSnapshots(resolvedAttachments)

	assistantMessage = &model.Message{
		ConversationID: input.ConversationID,
		UserID:         input.UserID,
		PublicID:       normalizePublicID(uuid.NewString()),
		RunID:          runID,
		Role:           "assistant",
		ContentType:    "video",
		Content:        "",
		BranchReason:   normalizedBranchReason,
		Status:         "pending",
		Attachments:    "[]",
	}
	if reuseUserMessage {
		reused := *branchState.ReuseUserMessage
		userMessage = &reused
		assistantMessage.ParentMessageID = &userMessage.ID
		assistantMessage.SourceMessageID = branchState.SourceMessageID
		if err = s.repo.CreateAssistantBranchMessage(ctx, assistantMessage); err != nil {
			retErr = mapMessageWriteError(err)
			return nil, retErr
		}
		assistantMessage.ParentPublicID = userMessage.PublicID
		assistantMessage.SourcePublicID = branchState.SourcePublicID
	} else {
		userMessage = &model.Message{
			ConversationID:  input.ConversationID,
			UserID:          input.UserID,
			PublicID:        normalizePublicID(uuid.NewString()),
			ParentMessageID: branchState.ParentMessageID,
			RunID:           runID,
			Role:            "user",
			ContentType:     mediaVideoUserContentType(len(resolvedAttachments) > 0),
			Content:         strings.TrimSpace(input.Prompt),
			BranchReason:    normalizedBranchReason,
			SourceMessageID: branchState.SourceMessageID,
			TokenUsage:      tokenestimate.Estimate(input.Prompt),
			InputTokens:     tokenestimate.Estimate(input.Prompt),
			Status:          "success",
			Attachments:     attachmentsJSON,
		}
		userAttachmentRows := mediaInputAttachmentRows(input.ConversationID, input.UserID, resolvedAttachments)
		if err = s.repo.CreateMessagePairWithUserAttachments(ctx, userMessage, assistantMessage, userAttachmentRows); err != nil {
			retErr = mapMessageWriteError(err)
			return nil, retErr
		}
		userMessage.ParentPublicID = branchState.ParentPublicID
		userMessage.SourcePublicID = branchState.SourcePublicID
		assistantMessage.ParentPublicID = userMessage.PublicID
	}
	traceRecorder := newMessageTraceRecorder(s, ctx, assistantMessage, input.OnEvent)
	defer func() {
		if retErr != nil && traceRecorder != nil {
			traceRecorder.fail(retErr)
			traceRecorder.attachToMessage(assistantMessage)
		}
	}()
	moderationFileIDs := make([]string, 0, len(resolvedAttachments))
	if taskType != MediaVideoTaskExtension {
		for _, item := range resolvedAttachments {
			// 审核屏障只覆盖提示词与图片；参考视频、参考音频不参与。
			if normalizeAttachmentKind(item.Kind, item.MimeType) != "image" {
				continue
			}
			if fileID := strings.TrimSpace(item.FileID); fileID != "" {
				moderationFileIDs = append(moderationFileIDs, fileID)
			}
		}
	}
	moderationCoord = s.startModerationRun(ctx, SendMessageInput{
		UserID:             input.UserID,
		ConversationID:     input.ConversationID,
		RequestID:          input.RequestID,
		Content:            strings.TrimSpace(input.Prompt),
		FileIDs:            moderationFileIDs,
		ClientRunID:        runID,
		OnEvent:            input.OnEvent,
		UsageAuthorization: input.UsageAuthorization,
	}, runID, userMessage, assistantMessage)
	emitMediaEvent(input.OnEvent, "queued", "video task queued", "video")

	cfg := s.cfg.Snapshot()
	attributionReferer, attributionTitle := s.llmAttribution()
	routeConfig := routeConfigFromResolved(route, videoEndpoint, attributionReferer, attributionTitle)
	filteredOptions := filterModelOptions(input.Options, route.Protocol, modelOptionPolicyConfig{
		Mode:                  cfg.ModelOptionPolicyMode,
		AllowedPathsJSON:      cfg.ModelOptionAllowedPaths,
		DeniedPathsJSON:       cfg.ModelOptionDeniedPaths,
		ModelCapabilitiesJSON: route.ModelCapabilitiesJSON,
	})
	if llm.NormalizeAdapter(route.Protocol) == llm.AdapterGeminiInteractions {
		filteredOptions = withGeminiInteractionResponseType(filteredOptions, "video")
	}
	if llm.NormalizeAdapter(route.Protocol) == llm.AdapterXAIVideoExtensions {
		llm.SanitizeXAIVideoExtensionOptions(filteredOptions)
	} else if llm.NormalizeAdapter(route.Protocol) == llm.AdapterXAIVideo {
		llm.SanitizeXAIVideoOptions(filteredOptions)
	} else if llm.NormalizeAdapter(route.Protocol) == llm.AdapterOpenAIVideo {
		llm.SanitizeOpenAIVideoOptions(filteredOptions)
	}
	filteredOptions = withDefaultMediaVideoDuration(filteredOptions, route.Protocol)
	durationSeconds := mediaDurationSecondsFromOptions(filteredOptions)
	buildFailureResult := func(failure error, usage llm.Usage) *SendMessageResult {
		result := buildFailedMediaBillingResult(failedMediaBillingResultInput{
			UserMessage:      userMessage,
			AssistantMessage: assistantMessage,
			Route:            *route,
			EffectiveOptions: filteredOptions,
			Usage:            usage,
			StartedAt:        startedAt,
			DurationSeconds:  durationSeconds,
			Failure:          failure,
			Billable:         false,
		})
		applyMediaRunUsage(run, result)
		return result
	}

	emitMediaEvent(input.OnEvent, "running", "generating video", "video")
	generateInput := llm.GenerateInput{
		RequestID:      strings.TrimSpace(input.RequestID),
		ConversationID: input.ConversationID,
		Messages: []llm.Message{{
			Role:    "user",
			Content: strings.TrimSpace(input.Prompt),
		}},
		Options:              filteredOptions,
		VideoExtensionSource: videoExtensionSource,
		// 上游任务提交成功即记录任务编号：后续失败可按此回查上游结果（任务重查）。
		// 同时立刻落库一次，且用脱离取消的上下文写：视频轮询可长达十分钟，
		// 若中途进程重启或请求被中断，编号只留在内存就会让上游结果永久不可回查。
		// 收尾时的整行写入仍会覆盖兜底。
		OnTaskStarted: func(upstreamTaskID string) {
			if run == nil {
				return
			}
			run.UpstreamTaskID = strings.TrimSpace(upstreamTaskID)
			if run.UpstreamTaskID == "" {
				return
			}
			persistCtx, cancelPersist := background.WithTimeout(ctx, 5*time.Second)
			defer cancelPersist()
			if err := s.repo.UpdateConversationRun(persistCtx, run); err != nil && s.logger != nil {
				s.logger.Warn("persist_upstream_task_id_failed",
					zap.String("run_id", run.RunID),
					zap.Error(err),
				)
			}
		},
		// 轮询期间的进度上报：转成进度事件推送前端，驱动输出节点的实时进度显示
		OnProgress: func(percent int) {
			if percent < 0 || percent > 100 {
				return
			}
			emitMediaEvent(input.OnEvent, "progress", fmt.Sprintf("%d%%", percent), "video")
		},
	}
	if len(videoInputParts) > 0 {
		parts := make([]llm.ContentPart, 0, 1+len(videoInputParts))
		parts = append(parts, llm.ContentPart{Kind: llm.ContentPartText, Text: strings.TrimSpace(input.Prompt)})
		parts = append(parts, videoInputParts...)
		generateInput.Messages = []llm.Message{{Role: "user", Parts: parts}}
	}

	output, err := s.llmClient.Generate(ctx, routeConfig, generateInput)
	if err != nil {
		if s.isCanceledMediaGeneration(ctx, runID, err) {
			retErr = ErrMessageGenerationCanceled
			var cancelErr error
			result, cancelErr = s.completeCanceledMediaGeneration(canceledMediaGenerationInput{
				Context:          ctx,
				Conversation:     conversation,
				UserMessage:      userMessage,
				AssistantMessage: assistantMessage,
				ReuseUserMessage: reuseUserMessage,
				Route:            *route,
				EffectiveOptions: filteredOptions,
				GenerateInput:    generateInput,
				StartedAt:        startedAt,
				DurationSeconds:  durationSeconds,
				Billable:         false,
			})
			if cancelErr != nil {
				retErr = cancelErr
				return nil, cancelErr
			}
			applyMediaRunUsage(run, result)
			return result, nil
		}
		switch {
		case errors.Is(err, llm.ErrVideoPollTimeout):
			// 平台自己放弃等待（轮询预算耗尽）：上游任务通常仍在正常执行，这不是渠道故障，
			// 因此不计入路由失败，也不能报成"上游服务不可用"；带上运行上下文让用户能按任务号回查。
			retErr = withRunContext(ErrMediaVideoPollTimeout, run)
		default:
			s.routeResolver.MarkRouteFailure(ctx, route, err)
			retErr = wrapUpstreamRequestError(err)
		}
		_ = s.repo.UpdateMessageState(ctx, assistantMessage.ID, "error", classifyRunErrorCode(retErr), textutil.TruncateTrimmed(messageErrorSummary(retErr), 255))
		return nil, retErr
	}
	s.routeResolver.MarkRouteSuccess(ctx, route)
	if output == nil || len(output.GeneratedVideos) == 0 {
		retErr = ErrUpstreamEmptyResponse
		_ = s.repo.UpdateMessageState(ctx, assistantMessage.ID, "error", classifyRunErrorCode(retErr), textutil.TruncateTrimmed(messageErrorSummary(retErr), 255))
		return buildFailureResult(retErr, mediaOutputUsage(output)), retErr
	}
	videoDurations, generatedDurationSeconds := resolveGeneratedVideoDurations(output.GeneratedVideos, durationSeconds)
	if taskType != MediaVideoTaskExtension && generatedDurationSeconds > 0 {
		durationSeconds = generatedDurationSeconds
	}

	emitMediaEvent(input.OnEvent, "saving_artifact", "saving video", "video")
	uploaded := make([]model.FileObject, 0, len(output.GeneratedVideos))
	attachmentRows := make([]model.Attachment, 0, len(output.GeneratedVideos))
	now := time.Now()
	for i, video := range output.GeneratedVideos {
		source := mediaArtifactSourceFor(route)
		data, mimeType, readErr := s.readGeneratedVideo(ctx, video, source)
		if readErr != nil && isRetryableGeneratedMediaDownload(readErr) {
			// 下载类瞬时故障自动重试一次，多数网络抖动在此消化
			data, mimeType, readErr = s.readGeneratedVideo(ctx, video, source)
		}
		if readErr != nil {
			if isRetryableGeneratedMediaDownload(readErr) && strings.TrimSpace(run.UpstreamTaskID) != "" {
				// 上游任务已完成：生成已成功，保存职责移交输出节点；
				// 视频重试复用任务重查接口（按 UpstreamTaskID 回查上游并回收产物）。
				emitMediaArtifactPendingEvent(input.OnEvent, run.RunID, "video", []int{i})
				s.logGeneratedMediaArtifactFailure(ctx, run, i+1, len(output.GeneratedVideos), readErr)
				retErr = readErr
				_ = s.repo.UpdateMessageState(ctx, assistantMessage.ID, "error", classifyRunErrorCode(readErr), textutil.TruncateTrimmed(messageErrorSummary(readErr), 255))
				return buildFailureResult(readErr, output.Usage), nil
			}
			retErr = s.finalizeGeneratedMediaArtifactFailure(ctx, run, assistantMessage.ID, i+1, len(output.GeneratedVideos), readErr)
			return buildFailureResult(retErr, output.Usage), retErr
		}
		fileName := generatedVideoFileName(route.PlatformModelName, now, i, len(output.GeneratedVideos), mimeType)
		uploadResult, uploadErr := s.uploadSvc.UploadFile(ctx, appupload.UploadFileInput{
			UserID:       input.UserID,
			Purpose:      "generated_video",
			FileName:     fileName,
			MimeType:     mimeType,
			DeclaredSize: int64(len(data)),
			Reader:       bytes.NewReader(data),
		})
		if uploadErr != nil {
			retErr = uploadErr
			_ = s.repo.UpdateMessageState(ctx, assistantMessage.ID, "error", classifyRunErrorCode(retErr), textutil.TruncateTrimmed(messageErrorSummary(retErr), 255))
			return buildFailureResult(uploadErr, output.Usage), uploadErr
		}
		file := uploadResult.File
		uploaded = append(uploaded, file)
		attachmentRows = append(attachmentRows, model.Attachment{
			ConversationID: input.ConversationID,
			MessageID:      assistantMessage.ID,
			UserID:         input.UserID,
			FileID:         file.FileID,
			Kind:           "file",
			FileName:       file.FileName,
			MimeType:       file.DetectedMIME,
			FileSize:       file.SizeBytes,
			SHA256:         file.SHA256,
			StoragePath:    file.StoragePath,
			Status:         "active",
			MetaJSON:       generatedVideoAttachmentMetaJSON(videoDurations[i]),
			UploadedAt:     now,
		})
	}

	usage := output.Usage
	if reuseUserMessage {
		assistantMessage.InputTokens = usage.InputTokens
		assistantMessage.CacheReadTokens = usage.CacheReadTokens
		assistantMessage.CacheWriteTokens = usage.CacheWriteTokens
	} else {
		userMessage.InputTokens = usage.InputTokens
		userMessage.CacheReadTokens = usage.CacheReadTokens
		userMessage.CacheWriteTokens = usage.CacheWriteTokens
		userMessage.TokenUsage = usage.InputTokens + usage.CacheReadTokens + usage.CacheWriteTokens
	}

	content := generatedVideoMarkdown(uploaded)
	latencyMS := time.Since(startedAt).Milliseconds()
	if reuseUserMessage {
		err = s.repo.CompleteAssistantMessageWithGeneratedAttachments(ctx,
			assistantMessage.ID,
			repository.AssistantMessageCompletionUpdate{
				ContentType:      "video",
				Content:          content,
				InputTokens:      usage.InputTokens,
				OutputTokens:     usage.OutputTokens,
				CacheReadTokens:  usage.CacheReadTokens,
				CacheWriteTokens: usage.CacheWriteTokens,
				ReasoningTokens:  usage.ReasoningTokens,
				LatencyMS:        latencyMS,
				Status:           "success",
			},
			attachmentRows,
		)
	} else {
		err = s.repo.CompleteAssistantMessageWithAttachments(ctx,
			userMessage.ID,
			repository.MessageUsageUpdate{
				InputTokens:      usage.InputTokens,
				CacheReadTokens:  usage.CacheReadTokens,
				CacheWriteTokens: usage.CacheWriteTokens,
			},
			assistantMessage.ID,
			repository.AssistantMessageCompletionUpdate{
				ContentType:     "video",
				Content:         content,
				OutputTokens:    usage.OutputTokens,
				ReasoningTokens: usage.ReasoningTokens,
				LatencyMS:       latencyMS,
				Status:          "success",
			},
			attachmentRows,
		)
	}
	if err != nil {
		retErr = err
		return buildFailureResult(err, output.Usage), err
	}

	assistantMessage.Content = content
	assistantMessage.OutputTokens = usage.OutputTokens
	assistantMessage.ReasoningTokens = usage.ReasoningTokens
	assistantMessage.TokenUsage = usage.OutputTokens + usage.ReasoningTokens
	if reuseUserMessage {
		assistantMessage.TokenUsage += usage.InputTokens + usage.CacheReadTokens + usage.CacheWriteTokens
	}
	assistantMessage.LatencyMS = latencyMS
	assistantMessage.Status = "success"
	assistantMessage.Attachments = string(marshalAttachmentSnapshots(videoAttachmentsFromFiles(uploaded, videoDurations)))
	run.InputTokens = usage.InputTokens
	run.OutputTokens = usage.OutputTokens
	run.CacheReadTokens = usage.CacheReadTokens
	run.CacheWriteTokens = usage.CacheWriteTokens
	run.ReasoningTokens = usage.ReasoningTokens

	result = &SendMessageResult{
		UserMessage:         *userMessage,
		AssistantMessage:    *assistantMessage,
		MetadataRefreshHint: s.resolveConversationMetadataRefreshHint(ctx, *conversation, *userMessage),
		Billable:            true,
		UpstreamID:          route.UpstreamID,
		UpstreamName:        route.UpstreamName,
		PlatformModelName:   route.PlatformModelName,
		RoutedBindingCode:   route.BindingCode,
		UpstreamModelName:   route.UpstreamModel,
		UpstreamProtocol:    route.Protocol,
		EffectiveOptions:    filteredOptions,
		UsageSpeed:          usage.Speed,
		UsageServiceTier:    usage.ServiceTier,
		RawUsageJSON:        usage.RawUsageJSON,
		CacheWrite5mTokens:  usage.CacheWrite5mTokens,
		CacheWrite1hTokens:  usage.CacheWrite1hTokens,
		StartedAt:           startedAt,
		LatencyMS:           latencyMS,
		DurationSeconds:     durationSeconds,
	}
	if moderationCoord != nil {
		// Omni Moderation 不支持视频模态。提示词与可选的输入
		// 图片参与屏障；扩展来源被有意排除。
		s.completeModerationAfterSuccess(ctx, completeModerationAfterSuccessInput{
			Coordinator:      moderationCoord,
			Result:           result,
			EmbedInput:       SendMessageInput{UserID: input.UserID, ConversationID: input.ConversationID},
			ReuseUserMessage: reuseUserMessage,
		})
	}
	return result, nil
}

func normalizeMediaVideoTaskType(taskType MediaVideoTaskType) MediaVideoTaskType {
	if taskType == MediaVideoTaskExtension {
		return MediaVideoTaskExtension
	}
	return MediaVideoTaskGeneration
}

func mediaVideoUserContentType(hasInputs bool) string {
	if hasInputs {
		return "mixed"
	}
	return "text"
}

func (s *Service) resolveMediaVideoInputs(ctx context.Context, input MediaVideoInput, taskType MediaVideoTaskType) ([]AttachmentInput, []llm.ContentPart, *llm.ContentPart, error) {
	if len(input.FileIDs) == 0 {
		if taskType == MediaVideoTaskExtension {
			return nil, nil, nil, ErrMediaVideoInputInvalid
		}
		return nil, nil, nil, nil
	}
	attachments, err := s.resolveAttachments(ctx, input.UserID, input.FileIDs)
	if err != nil {
		return nil, nil, nil, err
	}
	if taskType == MediaVideoTaskExtension {
		if len(attachments) != 1 {
			return nil, nil, nil, ErrMediaVideoInputInvalid
		}
		part, readErr := s.readMediaVideoExtensionSource(ctx, input.UserID, attachments[0].FileID)
		if readErr != nil {
			return nil, nil, nil, readErr
		}
		return attachments, nil, &part, nil
	}
	parts, err := s.readMediaVideoReferenceParts(input.UserID, attachments)
	if err != nil {
		return nil, nil, nil, err
	}
	return attachments, parts, nil, nil
}

// readMediaVideoReferenceParts 按类别组装视频生成的参考素材：图片进入 images、
// 视频进入 videos、音频进入 audios，顺序保持上传顺序。
// 素材一律以服务端签发的限时公开 URL 交付上游（见 docs/adr/0003），不再读取文件字节。
func (s *Service) readMediaVideoReferenceParts(userID uint, attachments []AttachmentInput) ([]llm.ContentPart, error) {
	parts := make([]llm.ContentPart, 0, len(attachments))
	imageCount, videoCount, audioCount := 0, 0, 0
	for _, attachment := range attachments {
		var kind string
		switch normalizeAttachmentKind(attachment.Kind, attachment.MimeType) {
		case "image":
			if imageCount++; imageCount > maxMediaVideoInputImages {
				return nil, ErrMediaVideoTooManyInputs
			}
			kind = llm.ContentPartImage
		case "video":
			if videoCount++; videoCount > maxMediaVideoInputVideos {
				return nil, ErrMediaVideoTooManyInputs
			}
			kind = llm.ContentPartVideo
		case "audio":
			if audioCount++; audioCount > maxMediaVideoInputAudios {
				return nil, ErrMediaVideoTooManyInputs
			}
			kind = llm.ContentPartAudio
		default:
			return nil, ErrMediaVideoInputInvalid
		}
		part, err := s.mediaVideoReferencePart(userID, attachment, kind)
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
	}
	return parts, nil
}

// mediaVideoReferencePart 为单个参考素材签发上游可回源拉取的限时 URL。
// 未配置公网 API 地址或签名密钥时直接失败，不伪造地址、也不回退内联字节。
func (s *Service) mediaVideoReferencePart(userID uint, attachment AttachmentInput, kind string) (llm.ContentPart, error) {
	materialURL := strings.TrimSpace(s.uploadSvc.BuildSignedFileContentURL(userID, strings.TrimSpace(attachment.FileID)))
	if materialURL == "" {
		return llm.ContentPart{}, ErrMediaVideoReferenceURLUnavailable
	}
	return llm.ContentPart{
		Kind:     kind,
		MimeType: strings.TrimSpace(attachment.MimeType),
		FileName: strings.TrimSpace(attachment.FileName),
		URL:      materialURL,
	}, nil
}

func (s *Service) readMediaVideoExtensionSource(ctx context.Context, userID uint, fileID string) (llm.ContentPart, error) {
	content, err := s.uploadSvc.OpenFileContent(ctx, userID, strings.TrimSpace(fileID))
	if err != nil {
		return llm.ContentPart{}, err
	}
	defer content.Reader.Close() //nolint:errcheck
	limit := s.cfg.Snapshot().MaxUploadFileBytes
	if limit <= 0 {
		limit = 20 * 1024 * 1024
	}
	data, err := io.ReadAll(io.LimitReader(content.Reader, limit+1))
	if err != nil {
		return llm.ContentPart{}, err
	}
	if int64(len(data)) > limit {
		return llm.ContentPart{}, ErrFileTooLarge
	}
	if detectGeneratedVideoMIME(data) != "video/mp4" {
		return llm.ContentPart{}, ErrMediaVideoInputInvalid
	}
	return llm.ContentPart{Kind: llm.ContentPartVideo, MimeType: "video/mp4", Data: data, FileName: content.File.FileName}, nil
}

func mediaInputAttachmentRows(conversationID uint, userID uint, attachments []AttachmentInput) []model.Attachment {
	rows := make([]model.Attachment, 0, len(attachments))
	now := time.Now()
	for _, item := range attachments {
		rows = append(rows, model.Attachment{
			ConversationID: conversationID,
			UserID:         userID,
			FileID:         strings.TrimSpace(item.FileID),
			Kind:           normalizeAttachmentKind(item.Kind, item.MimeType),
			FileName:       strings.TrimSpace(item.FileName),
			MimeType:       strings.TrimSpace(item.MimeType),
			FileSize:       item.FileSize,
			SHA256:         strings.TrimSpace(item.SHA256),
			StoragePath:    strings.TrimSpace(item.StoragePath),
			Status:         "active",
			MetaJSON:       strings.TrimSpace(item.MetaJSON),
			UploadedAt:     now,
		})
	}
	return rows
}

func (s *Service) readGeneratedVideo(ctx context.Context, video llm.GeneratedVideo, source mediaArtifactSource) ([]byte, string, error) {
	mimeType := strings.TrimSpace(video.MIMEType)
	if mimeType == "" {
		mimeType = "video/mp4"
	}
	if b64 := strings.TrimSpace(video.B64JSON); b64 != "" {
		data, err := base64.StdEncoding.DecodeString(stripBase64DataURLPrefix(b64))
		if err != nil {
			return nil, mimeType, newGeneratedMediaArtifactError("video", "decode", err)
		}
		validated, detectedMIME, validationErr := validateGeneratedVideoBytes(data, mimeType)
		if validationErr != nil {
			return nil, mimeType, newGeneratedMediaArtifactError("video", "validation", validationErr)
		}
		return validated, detectedMIME, nil
	}
	url := strings.TrimSpace(video.URL)
	if url == "" {
		return nil, mimeType, ErrUpstreamEmptyResponse
	}
	downloader := s.mediaDownloaderFor(source)
	if downloader == nil {
		return nil, mimeType, newGeneratedMediaArtifactError("video", "configuration", fmt.Errorf("generated media downloader is not configured"))
	}
	cfg := s.cfg.Snapshot()
	limit := cfg.MaxUploadFileBytes
	if limit <= 0 {
		limit = 20 * 1024 * 1024
	}
	data, downloadedMIME, err := downloader.DownloadVideo(ctx, url, source.endpoint, source.apiKey, limit)
	if err != nil {
		if isMediaArtifactResponseTooLarge(err) {
			return nil, mimeType, ErrFileTooLarge
		}
		return nil, mimeType, newGeneratedMediaArtifactError("video", "download", err)
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(downloadedMIME)), "video/") {
		mimeType = strings.TrimSpace(downloadedMIME)
	}
	validated, detectedMIME, validationErr := validateGeneratedVideoBytes(data, mimeType)
	if validationErr != nil {
		return nil, mimeType, newGeneratedMediaArtifactError("video", "validation", validationErr)
	}
	return validated, detectedMIME, nil
}

func validateGeneratedVideoBytes(data []byte, declaredMIME string) ([]byte, string, error) {
	detected := detectGeneratedVideoMIME(data)
	if detected == "" {
		return nil, strings.TrimSpace(declaredMIME), ErrMediaVideoInputInvalid
	}
	return data, detected, nil
}

func detectGeneratedVideoMIME(data []byte) string {
	if len(data) >= 12 && bytes.Equal(data[4:8], []byte("ftyp")) {
		return "video/mp4"
	}
	if len(data) >= 4 && bytes.Equal(data[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		return "video/webm"
	}
	return ""
}

func generatedVideoFileName(modelName string, capturedAt time.Time, index int, total int, mimeType string) string {
	base := sanitizeGeneratedImageFileBase(generatedImageModelBase(modelName))
	if base == "image" {
		base = "video"
	}
	timestamp := fmt.Sprintf("%s-%03d", capturedAt.Format("20060102-150405"), capturedAt.Nanosecond()/int(time.Millisecond))
	if total > 1 {
		return fmt.Sprintf("%s-%s-%02d%s", base, timestamp, index+1, videoFileExtension(mimeType))
	}
	return fmt.Sprintf("%s-%s%s", base, timestamp, videoFileExtension(mimeType))
}

func videoFileExtension(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "video/webm":
		return ".webm"
	default:
		return ".mp4"
	}
}

func generatedVideoMarkdown(files []model.FileObject) string {
	blocks := make([]string, 0, len(files))
	for i, file := range files {
		label := "Generated video"
		if len(files) > 1 {
			label = fmt.Sprintf("Generated video %d", i+1)
		}
		blocks = append(blocks, fmt.Sprintf("[%s](/api/v1/files/%s/content)", label, file.FileID))
	}
	return strings.Join(blocks, "\n\n")
}

func generatedVideoAttachmentMetaJSON(durationSeconds int64) string {
	if durationSeconds <= 0 {
		return ""
	}
	payload, err := json.Marshal(map[string]int64{"duration_seconds": durationSeconds})
	if err != nil {
		return ""
	}
	return string(payload)
}

func videoAttachmentsFromFiles(files []model.FileObject, durations []int64) []AttachmentInput {
	items := make([]AttachmentInput, 0, len(files))
	for index, file := range files {
		durationSeconds := int64(0)
		if index < len(durations) {
			durationSeconds = positiveSeconds(durations[index])
		}
		items = append(items, AttachmentInput{
			FileObjID:        file.ID,
			FileID:           file.FileID,
			Kind:             "file",
			FileName:         file.FileName,
			MimeType:         file.MimeType,
			DetectedMIME:     file.DetectedMIME,
			FileCategory:     file.FileCategory,
			FileSize:         file.SizeBytes,
			SHA256:           file.SHA256,
			StoragePath:      file.StoragePath,
			ProcessingStatus: file.ProcessingStatus,
			ProcessingReady:  file.ProcessingReady,
			DurationSeconds:  durationSeconds,
		})
	}
	return items
}
