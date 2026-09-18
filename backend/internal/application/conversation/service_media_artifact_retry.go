package conversation

import (
	"context"
	"errors"
	"strings"
	"time"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/traceid"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"go.uber.org/zap"
)

// 图像制品重试：上游生成已成功但产物下载瞬时失败时，保存职责移交输出节点；
// 输出节点按 runID + 产物序号逐个重试：取回上游 URL 引用 -> 重新下载 -> 上传 ->
// 追加写入 assistant 消息附件。重试仍失败时引用重新登记（TTL 内可继续重试）。

// MediaImageArtifactRetryStatus 图像制品重试结果状态。
type MediaImageArtifactRetryStatus string

const (
	MediaImageArtifactRetryRecovered MediaImageArtifactRetryStatus = "recovered"
	MediaImageArtifactRetryExpired   MediaImageArtifactRetryStatus = "expired"
)

// MediaImageArtifactRetryAttachment 重试回收到的产物附件（供前端写入画布输出节点）。
type MediaImageArtifactRetryAttachment struct {
	FileID    string `json:"fileID"`
	FileName  string `json:"fileName"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

// MediaImageArtifactRetryResult 重试结果。
type MediaImageArtifactRetryResult struct {
	Status     MediaImageArtifactRetryStatus      `json:"status"`
	Message    string                             `json:"message,omitempty"`
	RunID      string                             `json:"runID"`
	Index      int                                `json:"index"`
	Attachment *MediaImageArtifactRetryAttachment `json:"attachment,omitempty"`
}

// RetryMediaImageArtifact 对待保存的图像产物执行一次保存重试。
func (s *Service) RetryMediaImageArtifact(ctx context.Context, userID uint, runID string, index int) (*MediaImageArtifactRetryResult, error) {
	// 与写入侧对齐：clientRunID 入库前统一规范化，查询必须同样处理
	runID = normalizeRunID(runID)
	if s.routeResolver == nil || s.llmClient == nil {
		return nil, ErrModelRouteNotConfigured
	}
	if userID == 0 || runID == "" || index < 0 {
		return nil, repository.ErrInvalidInput
	}
	run, err := s.repo.GetConversationRunByRunID(ctx, userID, runID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrConversationNotFound
		}
		return nil, err
	}
	if run.TaskType != string(MediaImageTaskGeneration) && run.TaskType != string(MediaImageTaskEdit) {
		return nil, ErrMediaRouteProtocolMismatch
	}
	artifact, ok := s.pendingArtifacts.Take(runID, index)
	if !ok {
		// 引用过期或已被回收：产物无法找回，用户需重新生成
		return &MediaImageArtifactRetryResult{
			Status:  MediaImageArtifactRetryExpired,
			Message: "generated artifact reference expired; regenerate to retry",
			RunID:   runID,
			Index:   index,
		}, nil
	}

	route, err := s.routeResolver.BuildRouteForUpstream(ctx, run.UpstreamID, run.ProviderProtocol, run.UpstreamModelName)
	if err != nil {
		s.pendingArtifacts.Register(runID, []pendingImageArtifact{artifact})
		return nil, mapRouteResolutionError(err)
	}

	// 重新下载并校验：网络抖动自动重试一次
	image := llm.GeneratedImage{URL: artifact.URL, MIMEType: artifact.MimeType}
	data, mimeType, readErr := s.readGeneratedImage(ctx, image, route.BaseURL)
	if readErr != nil && isRetryableGeneratedMediaDownload(readErr) {
		data, mimeType, readErr = s.readGeneratedImage(ctx, image, route.BaseURL)
	}
	if readErr != nil {
		// 引用仍有效：重新登记供输出节点继续重试
		s.pendingArtifacts.Register(runID, []pendingImageArtifact{artifact})
		s.logArtifactRetryFailure(ctx, run, index, "download_artifact", readErr)
		return nil, wrapUpstreamRequestError(readErr)
	}

	fileName := generatedImageFileName(run.PlatformModelName, time.Now(), index, index+1, mimeType)
	uploadInput := appupload.UploadFileInput{
		UserID:       userID,
		Purpose:      "generated_image",
		FileName:     fileName,
		MimeType:     mimeType,
		DeclaredSize: int64(len(data)),
	}
	uploadResult, uploadErr := s.uploadSvc.UploadFile(ctx, uploadInputWith(uploadInput, data))
	if uploadErr != nil {
		// 上传瞬时故障自动重试一次（数据仍在内存，仅重试传输）
		uploadResult, uploadErr = s.uploadSvc.UploadFile(ctx, uploadInputWith(uploadInput, data))
	}
	if uploadErr != nil {
		s.pendingArtifacts.Register(runID, []pendingImageArtifact{artifact})
		s.logArtifactRetryFailure(ctx, run, index, "persist_artifact", uploadErr)
		return nil, uploadErr
	}
	file := uploadResult.File

	assistantMessageID, err := s.repo.FindAssistantMessageIDByRunID(ctx, userID, runID)
	if err != nil {
		s.logArtifactRetryFailure(ctx, run, index, "find_assistant_message", err)
		return nil, err
	}
	if assistantMessageID == 0 {
		err := ErrConversationNotFound
		s.logArtifactRetryFailure(ctx, run, index, "find_assistant_message", err)
		return nil, err
	}

	// 部分成功场景消息已有图片内容：追加 markdown，避免覆盖已保存产物
	content := generatedImageMarkdown([]model.FileObject{file})
	if existing, msgErr := s.repo.GetMessageByID(ctx, run.ConversationID, assistantMessageID); msgErr == nil && existing != nil {
		if prefix := strings.TrimSpace(existing.Content); prefix != "" && !strings.HasPrefix(prefix, "!") {
			content = prefix + "\n\n" + content
		}
	}
	if err := s.repo.CompleteAssistantMessageWithGeneratedAttachments(ctx,
		assistantMessageID,
		repository.AssistantMessageCompletionUpdate{
			ContentType: "image",
			Content:     content,
			Status:      "success",
		},
		[]model.Attachment{{
			ConversationID: run.ConversationID,
			MessageID:      assistantMessageID,
			UserID:          userID,
			FileID:          file.FileID,
			Kind:            "image",
			FileName:        file.FileName,
			MimeType:        file.DetectedMIME,
			FileSize:        file.SizeBytes,
			SHA256:          file.SHA256,
			StoragePath:     file.StoragePath,
			Status:          "active",
			UploadedAt:      time.Now(),
		}},
	); err != nil {
		s.logArtifactRetryFailure(ctx, run, index, "complete_assistant_message", err)
		return nil, err
	}

	return &MediaImageArtifactRetryResult{
		Status: MediaImageArtifactRetryRecovered,
		RunID:  runID,
		Index:  index,
		Attachment: &MediaImageArtifactRetryAttachment{
			FileID:    file.FileID,
			FileName:  file.FileName,
			MimeType:  file.DetectedMIME,
			SizeBytes: file.SizeBytes,
		},
	}, nil
}

// logArtifactRetryFailure 记录图像制品重试各失败环节的结构化诊断日志（不含 URL 与媒体内容）。
func (s *Service) logArtifactRetryFailure(ctx context.Context, run *model.Run, index int, stage string, err error) {
	if s == nil || s.logger == nil || run == nil || err == nil {
		return
	}
	s.logger.Warn("media_image_artifact_retry_failed",
		zap.String("trace_id", traceid.FromContext(ctx)),
		zap.String("error_code", "media.artifact_retry_failed"),
		zap.String("failure_stage", strings.TrimSpace(stage)),
		zap.Int("artifact_index", index),
		zap.String("run_id", strings.TrimSpace(run.RunID)),
		zap.Uint("user_id", run.UserID),
		zap.Uint("conversation_id", run.ConversationID),
		zap.String("task_type", strings.TrimSpace(run.TaskType)),
		zap.String("platform_model_name", strings.TrimSpace(run.PlatformModelName)),
		zap.Error(err),
	)
}
