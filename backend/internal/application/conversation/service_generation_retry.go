package conversation

import (
	"context"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/pkg/traceid"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
	"go.uber.org/zap"
)

var (
	// followUpGenerationMaxRetries 工具回灌等中途上游调用的同路由自动重试上限。
	followUpGenerationMaxRetries = 2
	// followUpGenerationRetryBaseBackoff 首次重试前的等待时间，按尝试次数线性递增。
	// 测试中可调小以加速断言。
	followUpGenerationRetryBaseBackoff = 800 * time.Millisecond
)

// shouldRetryGenerationAttempt 与路由故障转移共用同一套可重试口径：
// 超时、限流（429）、5xx 与网络错误可重试；上游已受理请求（可能已产生输出）、
// 4xx 拒绝与调用方取消不重试，避免重复输出或无意义的重试。
func shouldRetryGenerationAttempt(err error) bool {
	return channel.ShouldFailoverRoute(err)
}

// canRetryFollowUpGeneration 汇总中途调用的重试前置条件：LLM 调用预算未耗尽，
// 且失败的这次尝试未向客户端发出任何可见事件（用量、推理、工具、正文增量），
// 重试不会造成重复输出。attemptHadSideEffect 反映整条消息的累计副作用，
// 这里只看本次尝试的 lastAttemptObservation，因此工具循环内的后续调用也能就地重试。
func (r *messageGenerationRunner) canRetryFollowUpGeneration(err error) bool {
	return err != nil &&
		r.llmRequestCount < r.maxLLMCalls &&
		r.lastAttemptObservation.canRetry(err, shouldRetryGenerationAttempt)
}

// generateWithRetry 在 generate 之上为多轮运行的中途调用（工具回灌、最终综合）提供
// 就地自动重试：单次上游瞬时错误（如 5xx、超时、限流）不再让整条 agent 运行中断，
// 而是在同一路由上按短退避重试，直到成功、预算耗尽或错误不可重试。
// 每次重试计入 maxLLMCalls 预算，且仅在本次尝试无可见副作用时进行。
func (r *messageGenerationRunner) generateWithRetry(ctx context.Context, currentInput llm.GenerateInput, fullMessages []llm.Message) (*llm.GenerateOutput, error) {
	output, err := r.generate(ctx, currentInput, fullMessages)
	for attempt := 1; err != nil && attempt <= followUpGenerationMaxRetries; attempt++ {
		if generationCanceled(ctx, err) || !r.canRetryFollowUpGeneration(err) {
			return output, err
		}
		backoff := followUpGenerationRetryBaseBackoff * time.Duration(attempt)
		select {
		case <-ctx.Done():
			return output, ctx.Err()
		case <-time.After(backoff):
		}
		if r.service != nil && r.service.logger != nil {
			r.service.logger.Warn("upstream_generation_retry",
				zap.String("trace_id", traceid.FromContext(ctx)),
				zap.Uint("conversation_id", r.input.ConversationID),
				zap.String("protocol", r.routeConfig.Protocol),
				zap.String("upstream_model", r.routeConfig.UpstreamModel),
				zap.Int("llm_request_count", r.llmRequestCount),
				zap.Int("attempt", attempt),
				zap.Error(err),
			)
		}
		output, err = r.generate(ctx, currentInput, fullMessages)
	}
	return output, err
}
