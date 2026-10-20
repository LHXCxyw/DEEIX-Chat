package conversation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/traceid"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"go.uber.org/zap"
)

// buildMediaRunRoute 为已提交的媒体任务重建路由。
// 平台上游按上游 ID 定点重建：回查必须回到原上游，不能负载均衡到别的渠道。
// 个人模型路由不带平台上游 ID，此时按生成时同口径（模型名 + 用户作用域）重新解析；
// 个人模型只有一条路由（见 personalprovider.RouteResolver），不会选到别的上游。
func (s *Service) buildMediaRunRoute(ctx context.Context, run *model.Run, userID uint) (*channel.ResolvedRoute, error) {
	if run == nil {
		return nil, ErrModelRouteNotConfigured
	}
	if run.UpstreamID != 0 {
		return s.routeResolver.BuildRouteForUpstream(ctx, run.UpstreamID, run.ProviderProtocol, run.UpstreamModelName)
	}
	platformModelName := strings.TrimSpace(run.RequestedModelName)
	if platformModelName == "" {
		platformModelName = strings.TrimSpace(run.PlatformModelName)
	}
	if platformModelName == "" {
		return nil, ErrMediaRequeryUnavailable
	}
	return s.routeResolver.ResolveRoute(ctx, channel.ResolveRouteInput{
		PlatformModelName: platformModelName,
		TaskType:          strings.TrimSpace(run.TaskType),
		Scope:             channel.RouteScopeUser,
		UserID:            userID,
		ConversationID:    run.ConversationID,
	})
}

// 任务重查：异步媒体任务（视频生成）在 DEEIX 侧报错后，上游任务可能仍在执行并成功。
// 重查按 run 上记录的上游任务 ID 定点回原上游查询，completed 时回收产物：
// 下载视频 -> 落文件对象 -> 补写 assistant 消息附件 -> run 置为 success。
//
// 计费说明：失败运行未结算费用；重查成功后同样不补扣（沿用"失败不计费"原则），
// 由渠道侧自行承担已执行的上游成本。

// MediaVideoRequeryStatus 重查返回的任务状态。
type MediaVideoRequeryStatus string

const (
	MediaVideoRequeryCompleted MediaVideoRequeryStatus = "completed"
	MediaVideoRequeryPending   MediaVideoRequeryStatus = "pending"
	MediaVideoRequeryFailed    MediaVideoRequeryStatus = "failed"
)

// MediaVideoRequeryAttachment 重查回收到的产物附件（供前端直接写入画布输出节点）。
type MediaVideoRequeryAttachment struct {
	FileID          string `json:"fileID"`
	FileName        string `json:"fileName"`
	MimeType        string `json:"mimeType"`
	SizeBytes       int64  `json:"sizeBytes"`
	DurationSeconds int64  `json:"durationSeconds,omitempty"`
}

// MediaVideoRequeryResult 重查结果。
type MediaVideoRequeryResult struct {
	Status      MediaVideoRequeryStatus       `json:"status"`
	Message     string                        `json:"message,omitempty"`
	RunID       string                        `json:"runID"`
	Attachments []MediaVideoRequeryAttachment `json:"attachments,omitempty"`
	// Progress 是上游上报的进度百分比；-1 表示上游未提供，客户端应显示不确定态。
	Progress int `json:"progress"`
}

// requeryableVideoProtocols 支持任务重查的协议：具备异步任务 ID 的视频协议。
// sync 基底仅实现 xAI 视频协议族与 OpenAI Sora 兼容视频协议。
var requeryableVideoProtocols = map[string]struct{}{
	llm.AdapterXAIVideo:           {},
	llm.AdapterXAIVideoExtensions: {},
	llm.AdapterOpenAIVideo:        {},
}

// RequeryMediaVideoRun 对失败的视频生成运行执行一次上游任务重查。
func (s *Service) RequeryMediaVideoRun(ctx context.Context, userID uint, runID string) (*MediaVideoRequeryResult, error) {
	if s.routeResolver == nil || s.llmClient == nil {
		return nil, ErrModelRouteNotConfigured
	}
	// 与写入侧对齐：clientRunID 入库前统一规范化（如补 run_ 前缀），查询必须同样处理
	runID = normalizeRunID(runID)
	if userID == 0 || runID == "" {
		return nil, repository.ErrInvalidInput
	}
	run, err := s.repo.GetConversationRunByRunID(ctx, userID, runID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationNotFound
		}
		return nil, err
	}
	if run.TaskType != string(MediaVideoTaskGeneration) {
		return nil, withRunContext(ErrMediaRouteProtocolMismatch, run)
	}
	adapter := llm.NormalizeAdapter(run.ProviderProtocol)
	if _, ok := requeryableVideoProtocols[adapter]; !ok {
		return nil, withRunContext(ErrMediaRouteProtocolMismatch, run)
	}
	if strings.TrimSpace(run.UpstreamTaskID) == "" {
		// 上游任务从未提交成功（如提交即被拒），没有可回查的对象
		return nil, withRunContext(ErrMediaRequeryUnavailable, run)
	}
	// 运行状态为 success 时同样允许重查：上游生成成功但产物未能落盘时，运行会被记为 success
	// 并把保存职责移交输出节点，此时重查正是唯一的回收路径；产物已落盘时重查只会重新下载一次。

	route, err := s.buildMediaRunRoute(ctx, run, userID)
	if err != nil {
		return nil, withRunContext(mapRouteResolutionError(err), run)
	}
	routeConfig := llm.RouteConfig{
		Protocol:         route.Protocol,
		BaseURL:          route.BaseURL,
		APIKey:           route.APIKey,
		HeadersJSON:      route.HeadersJSON,
		ConnectTimeoutMS: route.ConnectTimeoutMS,
		ReadTimeoutMS:    route.ReadTimeoutMS,
		UpstreamModel:    route.UpstreamModel,
	}

	retrieval, err := s.llmClient.RetrieveVideoTask(ctx, routeConfig, run.UpstreamTaskID)
	if err != nil {
		s.logRequeryFailure(ctx, run, "retrieve_upstream_task", err)
		return nil, wrapUpstreamRequestError(err)
	}
	switch retrieval.Status {
	case "pending":
		return &MediaVideoRequeryResult{
			Status:   MediaVideoRequeryPending,
			RunID:    run.RunID,
			Message:  retrieval.Message,
			Progress: retrieval.Progress,
		}, nil
	case "failed":
		return &MediaVideoRequeryResult{
			Status:   MediaVideoRequeryFailed,
			RunID:    run.RunID,
			Message:  retrieval.Message,
			Progress: -1,
		}, nil
	}

	if retrieval.Output == nil || len(retrieval.Output.GeneratedVideos) == 0 {
		return &MediaVideoRequeryResult{
			Status:  MediaVideoRequeryFailed,
			RunID:   run.RunID,
			Message: "upstream task completed without a downloadable video",
		}, nil
	}

	assistantMessageID, err := s.repo.FindAssistantMessageIDByRunID(ctx, userID, run.RunID)
	if err != nil {
		s.logRequeryFailure(ctx, run, "find_assistant_message", err)
		return nil, err
	}
	if assistantMessageID == 0 {
		err := ErrConversationNotFound
		s.logRequeryFailure(ctx, run, "find_assistant_message", err)
		return nil, err
	}

	// 回收产物：下载视频并落文件对象（与正常完成路径一致）
	source := mediaArtifactSourceFor(route)
	uploaded := make([]model.FileObject, 0, len(retrieval.Output.GeneratedVideos))
	attachmentRows := make([]model.Attachment, 0, len(retrieval.Output.GeneratedVideos))
	requeryAttachments := make([]MediaVideoRequeryAttachment, 0, len(retrieval.Output.GeneratedVideos))
	now := time.Now()
	for i, video := range retrieval.Output.GeneratedVideos {
		data, mimeType, readErr := s.readGeneratedVideo(ctx, video, source)
		if readErr != nil {
			s.logRequeryFailure(ctx, run, fmt.Sprintf("download_artifact_%d", i+1), readErr)
			return nil, readErr
		}
		fileName := generatedVideoFileName(run.PlatformModelName, now, i, len(retrieval.Output.GeneratedVideos), mimeType)
		uploadResult, uploadErr := s.uploadSvc.UploadFile(ctx, appupload.UploadFileInput{
			UserID:       userID,
			Purpose:      "generated_video",
			FileName:     fileName,
			MimeType:     mimeType,
			DeclaredSize: int64(len(data)),
			Reader:       bytes.NewReader(data),
		})
		if uploadErr != nil {
			s.logRequeryFailure(ctx, run, fmt.Sprintf("persist_artifact_%d", i+1), uploadErr)
			return nil, uploadErr
		}
		file := uploadResult.File
		uploaded = append(uploaded, file)
		attachmentRows = append(attachmentRows, model.Attachment{
			ConversationID: run.ConversationID,
			MessageID:      assistantMessageID,
			UserID:         userID,
			FileID:         file.FileID,
			Kind:           "file",
			FileName:       file.FileName,
			MimeType:       file.DetectedMIME,
			FileSize:       file.SizeBytes,
			SHA256:         file.SHA256,
			StoragePath:    file.StoragePath,
			Status:         "active",
			MetaJSON:       generatedVideoAttachmentMetaJSON(video.DurationSeconds),
			UploadedAt:     now,
		})
		requeryAttachments = append(requeryAttachments, MediaVideoRequeryAttachment{
			FileID:          file.FileID,
			FileName:        file.FileName,
			MimeType:        file.DetectedMIME,
			SizeBytes:       file.SizeBytes,
			DurationSeconds: video.DurationSeconds,
		})
	}

	// 补写 assistant 消息：状态 success + 视频内容 + 附件
	content := generatedVideoMarkdown(uploaded)
	if err := s.repo.CompleteAssistantMessageWithGeneratedAttachments(ctx,
		assistantMessageID,
		repository.AssistantMessageCompletionUpdate{
			ContentType: "video",
			Content:     content,
			Status:      "success",
			LatencyMS:   run.TotalLatencyMS,
		},
		attachmentRows,
	); err != nil {
		s.logRequeryFailure(ctx, run, "complete_assistant_message", err)
		return nil, err
	}

	// run 置为 success；ErrorCode 标记重查回收来源，原错误信息保留供审计
	endedAt := time.Now()
	run.Status = "success"
	run.ErrorCode = "media.requery_recovered"
	run.EndedAt = &endedAt
	if err := s.repo.UpdateConversationRun(ctx, run); err != nil {
		s.logRequeryFailure(ctx, run, "update_run", err)
		return nil, err
	}

	return &MediaVideoRequeryResult{
		Status:      MediaVideoRequeryCompleted,
		RunID:       run.RunID,
		Attachments: requeryAttachments,
	}, nil
}

// logRequeryFailure 在任务重查的每个可能失败环节记录结构化诊断日志。
// 重查失败此前直接透传为内部错误，无法定位是回查、下载、落盘还是落库环节的问题。
// 日志只包含运行上下文与失败阶段，不包含提示词、媒体内容或上游凭据。
func (s *Service) logRequeryFailure(ctx context.Context, run *model.Run, stage string, err error) {
	if s == nil || s.logger == nil || err == nil {
		return
	}
	fields := []zap.Field{
		zap.String("error_code", "media.requery_failed"),
		zap.String("failure_stage", strings.TrimSpace(stage)),
		zap.Error(err),
	}
	if run != nil {
		fields = append(fields,
			zap.String("trace_id", traceid.FromContext(ctx)),
			zap.String("request_id", strings.TrimSpace(run.RequestID)),
			zap.String("run_id", strings.TrimSpace(run.RunID)),
			zap.Uint("conversation_id", run.ConversationID),
			zap.Uint("user_id", run.UserID),
			zap.Uint("upstream_id", run.UpstreamID),
			zap.Uint("upstream_model_id", run.UpstreamModelID),
			zap.String("upstream_task_id", strings.TrimSpace(run.UpstreamTaskID)),
			zap.String("provider_protocol", strings.TrimSpace(run.ProviderProtocol)),
			zap.String("platform_model_name", strings.TrimSpace(run.PlatformModelName)),
			zap.String("upstream_model_name", strings.TrimSpace(run.UpstreamModelName)),
		)
	}
	s.logger.Warn("media_video_requery_failed", fields...)
}
