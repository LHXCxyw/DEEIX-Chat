package conversation

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/textutil"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/traceid"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/background"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/security"
	"go.uber.org/zap"
)

const MessageErrorCodeMediaArtifactUnavailable = "media.artifact_unavailable"

const generatedMediaArtifactFinalizeTimeout = 5 * time.Second

// generatedMediaArtifactError 将安全的用户语义与仅供内部诊断的原始原因隔离。
// 错误链只暴露安全的应用层哨兵，底层技术原因仅保留在 cause 中供结构化诊断。
type generatedMediaArtifactError struct {
	mediaType string
	stage     string
	cause     error
}

func (e *generatedMediaArtifactError) Error() string {
	return ErrGeneratedMediaArtifactUnavailable.Error()
}

func (e *generatedMediaArtifactError) Unwrap() error {
	return ErrGeneratedMediaArtifactUnavailable
}

// newGeneratedMediaArtifactError 收敛媒体制品技术错误，同时保留结构化诊断所需的内部原因。
func newGeneratedMediaArtifactError(mediaType string, stage string, cause error) error {
	return &generatedMediaArtifactError{
		mediaType: strings.TrimSpace(mediaType),
		stage:     strings.TrimSpace(stage),
		cause:     cause,
	}
}

// finalizeGeneratedMediaArtifactFailure 统一收敛制品读取失败的运行状态、持久化状态和诊断日志。
// 用户主动取消优先于技术错误，避免把 canceled run 重新记录为制品故障。
func (s *Service) finalizeGeneratedMediaArtifactFailure(
	ctx context.Context,
	run *model.Run,
	assistantMessageID uint,
	artifactIndex int,
	artifactCount int,
	err error,
) error {
	if err == nil {
		return nil
	}
	runID := ""
	if run != nil {
		runID = run.RunID
	}
	status := "error"
	persistCtx := ctx
	finalErr := err
	if s.isCanceledMediaGeneration(ctx, runID, err) {
		status = "canceled"
		var cancel context.CancelFunc
		persistCtx, cancel = background.WithTimeout(ctx, generatedMediaArtifactFinalizeTimeout)
		defer cancel()
		finalErr = ErrMessageGenerationCanceled
	} else if errors.Is(err, ErrGeneratedMediaArtifactUnavailable) {
		s.logGeneratedMediaArtifactFailure(ctx, run, artifactIndex, artifactCount, err)
	}
	if s != nil && s.repo != nil && assistantMessageID != 0 {
		_ = s.repo.UpdateMessageState(
			persistCtx,
			assistantMessageID,
			status,
			classifyRunErrorCode(finalErr),
			textutil.TruncateTrimmed(messageErrorSummary(finalErr), 255),
		)
	}
	return finalErr
}

// logGeneratedMediaArtifactFailure 在拥有完整运行上下文的调用点记录一次诊断日志。
// 不记录制品 URL、凭据、响应正文或媒体内容，避免签名参数和用户数据进入日志。
func (s *Service) logGeneratedMediaArtifactFailure(
	ctx context.Context,
	run *model.Run,
	artifactIndex int,
	artifactCount int,
	err error,
) {
	if s == nil || s.logger == nil || run == nil || err == nil {
		return
	}
	details := generatedMediaArtifactFailureDetails(err)
	s.logger.Warn("generated_media_artifact_failed",
		zap.String("trace_id", traceid.FromContext(ctx)),
		zap.String("request_id", strings.TrimSpace(run.RequestID)),
		zap.String("run_id", strings.TrimSpace(run.RunID)),
		zap.String("error_code", MessageErrorCodeMediaArtifactUnavailable),
		zap.Uint("user_id", run.UserID),
		zap.Uint("conversation_id", run.ConversationID),
		zap.String("task_type", strings.TrimSpace(run.TaskType)),
		zap.String("endpoint", strings.TrimSpace(run.Endpoint)),
		zap.String("media_type", details.mediaType),
		zap.Int("artifact_index", artifactIndex),
		zap.Int("artifact_count", artifactCount),
		zap.String("failure_stage", details.stage),
		zap.String("failure_class", classifyGeneratedMediaArtifactFailure(details.stage, details.cause)),
		zap.Uint("upstream_id", run.UpstreamID),
		zap.Uint("upstream_model_id", run.UpstreamModelID),
		zap.String("upstream_name", strings.TrimSpace(run.UpstreamName)),
		zap.String("provider_protocol", strings.TrimSpace(run.ProviderProtocol)),
		zap.String("platform_model_name", strings.TrimSpace(run.PlatformModelName)),
		zap.String("upstream_model_name", strings.TrimSpace(run.UpstreamModelName)),
		zap.String("routed_binding_code", strings.TrimSpace(run.RoutedBindingCode)),
		zap.String("model_vendor", strings.TrimSpace(run.ModelVendor)),
		zap.Error(details.cause),
	)
}

type generatedMediaArtifactFailure struct {
	mediaType string
	stage     string
	cause     error
}

// ---------------------------------------------------------------------------
// 待保存制品暂存：上游生成已成功但产物下载瞬时失败时，保存上游 URL 引用
// 供输出节点逐个重试。仅存小体积 URL 引用（不暂存媒体字节），
// 进程内存态，重启或超时后按过期处理，由用户重新生成。
// ---------------------------------------------------------------------------

// pendingArtifactTTL 待保存制品引用的存活时长（上游临时 URL 本身有时效）。
const pendingArtifactTTL = 10 * time.Minute

// pendingImageArtifact 记录一个待保存图像制品的上游引用与产物序号。
type pendingImageArtifact struct {
	URL      string
	MimeType string
	Index    int
}

// pendingArtifactStore 按 runID 暂存待保存制品引用，读写均懒清理过期条目。
type pendingArtifactStore struct {
	mu      sync.RWMutex
	entries map[string]pendingArtifactEntry
}

type pendingArtifactEntry struct {
	Artifacts []pendingImageArtifact
	ExpiresAt time.Time
}

func newPendingArtifactStore() *pendingArtifactStore {
	return &pendingArtifactStore{entries: make(map[string]pendingArtifactEntry)}
}

// Register 记录 runID 的待保存制品引用（追加合并，同 index 去重覆盖）并刷新 TTL。
func (p *pendingArtifactStore) Register(runID string, artifacts []pendingImageArtifact) {
	if p == nil || strings.TrimSpace(runID) == "" || len(artifacts) == 0 {
		return
	}
	key := strings.TrimSpace(runID)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sweepLocked()
	entry, ok := p.entries[key]
	if !ok {
		p.entries[key] = pendingArtifactEntry{Artifacts: artifacts, ExpiresAt: time.Now().Add(pendingArtifactTTL)}
		return
	}
	// 追加合并：重试后仍失败的产物重新登记，同 index 覆盖旧引用
	merged := make([]pendingImageArtifact, 0, len(entry.Artifacts)+len(artifacts))
	merged = append(merged, entry.Artifacts...)
	for _, artifact := range artifacts {
		replaced := false
		for i := range merged {
			if merged[i].Index == artifact.Index {
				merged[i] = artifact
				replaced = true
				break
			}
		}
		if !replaced {
			merged = append(merged, artifact)
		}
	}
	p.entries[key] = pendingArtifactEntry{Artifacts: merged, ExpiresAt: time.Now().Add(pendingArtifactTTL)}
}

// Take 移除并返回 runID 下指定 index 的制品引用；不存在或已过期返回 false。
func (p *pendingArtifactStore) Take(runID string, index int) (pendingImageArtifact, bool) {
	if p == nil {
		return pendingImageArtifact{}, false
	}
	key := strings.TrimSpace(runID)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sweepLocked()
	entry, ok := p.entries[key]
	if !ok {
		return pendingImageArtifact{}, false
	}
	for i, artifact := range entry.Artifacts {
		if artifact.Index != index {
			continue
		}
		remaining := make([]pendingImageArtifact, 0, len(entry.Artifacts)-1)
		remaining = append(remaining, entry.Artifacts[:i]...)
		remaining = append(remaining, entry.Artifacts[i+1:]...)
		if len(remaining) == 0 {
			delete(p.entries, key)
		} else {
			p.entries[key] = pendingArtifactEntry{Artifacts: remaining, ExpiresAt: entry.ExpiresAt}
		}
		return artifact, true
	}
	return pendingImageArtifact{}, false
}

// sweepLocked 清理过期条目（调用方持有写锁）。
func (p *pendingArtifactStore) sweepLocked() {
	now := time.Now()
	for key, entry := range p.entries {
		if now.After(entry.ExpiresAt) {
			delete(p.entries, key)
		}
	}
}

// emitMediaArtifactPendingEvent 通知前端：上游生成已成功，但部分产物保存待重试。
// 前端据此在输出节点上挂"保存失败可重试"状态，生成节点不再被保存失败占用。
func emitMediaArtifactPendingEvent(onEvent func(string, map[string]any) error, runID string, mediaType string, indexes []int) {
	if onEvent == nil || strings.TrimSpace(runID) == "" || len(indexes) == 0 {
		return
	}
	normalized := make([]int, 0, len(indexes))
	for _, index := range indexes {
		normalized = append(normalized, index)
	}
	_ = onEvent("media_artifact_pending", map[string]any{
		"run_id":     strings.TrimSpace(runID),
		"media_type": strings.TrimSpace(mediaType),
		"indexes":    normalized,
	})
}

// isRetryableGeneratedMediaDownload 判定制品读取失败是否属于可重试的下载类瞬时故障。
// 解码/校验失败属数据损坏、配置缺失属环境问题，重试无意义。
func isRetryableGeneratedMediaDownload(err error) bool {
	return generatedMediaArtifactFailureDetails(err).stage == "download"
}

func generatedMediaArtifactFailureDetails(err error) generatedMediaArtifactFailure {
	var artifactErr *generatedMediaArtifactError
	if errors.As(err, &artifactErr) && artifactErr != nil {
		return generatedMediaArtifactFailure{
			mediaType: artifactErr.mediaType,
			stage:     artifactErr.stage,
			cause:     artifactErr.cause,
		}
	}
	return generatedMediaArtifactFailure{cause: err}
}

func classifyGeneratedMediaArtifactFailure(stage string, cause error) string {
	switch {
	case errors.Is(cause, security.ErrUnsafeOutboundURL):
		return "outbound_policy"
	case errors.Is(cause, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(cause, context.Canceled):
		return "canceled"
	}
	var networkError net.Error
	if errors.As(cause, &networkError) && networkError.Timeout() {
		return "timeout"
	}
	switch strings.TrimSpace(stage) {
	case "decode", "validation":
		return "invalid_artifact"
	case "configuration":
		return "configuration"
	default:
		return "upstream_download"
	}
}
