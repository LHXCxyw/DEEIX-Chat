package conversation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

type retryTestGateway struct {
	generateCalls  int
	generateErrors []error
}

func (g *retryTestGateway) Generate(ctx context.Context, route llm.RouteConfig, input llm.GenerateInput) (*llm.GenerateOutput, error) {
	index := g.generateCalls
	g.generateCalls++
	if index < len(g.generateErrors) {
		return nil, g.generateErrors[index]
	}
	return &llm.GenerateOutput{Text: "ok"}, nil
}

func (g *retryTestGateway) GenerateStream(ctx context.Context, route llm.RouteConfig, input llm.GenerateInput, onEvent func(llm.GenerateStreamEvent) error) (*llm.GenerateOutput, error) {
	return nil, errors.New("unexpected stream call")
}

func (g *retryTestGateway) RetrieveOpenAIResponse(ctx context.Context, route llm.RouteConfig, responseID string) (*llm.GenerateOutput, error) {
	return nil, errors.New("unexpected retrieve call")
}

func (g *retryTestGateway) CancelOpenAIResponse(ctx context.Context, route llm.RouteConfig, responseID string) (*llm.GenerateOutput, error) {
	return nil, errors.New("unexpected cancel call")
}

func (g *retryTestGateway) RetrieveVideoTask(ctx context.Context, route llm.RouteConfig, taskID string) (*llm.VideoTaskRetrieval, error) {
	return nil, errors.New("unexpected video retrieve call")
}

// configureFastRetry 调快重试参数并在测试结束后恢复。
func configureFastRetry(t *testing.T) {
	t.Helper()
	originalMaxRetries := followUpGenerationMaxRetries
	originalBackoff := followUpGenerationRetryBaseBackoff
	followUpGenerationMaxRetries = 2
	followUpGenerationRetryBaseBackoff = time.Millisecond
	t.Cleanup(func() {
		followUpGenerationMaxRetries = originalMaxRetries
		followUpGenerationRetryBaseBackoff = originalBackoff
	})
}

func newRetryTestRunner(gateway *retryTestGateway, maxLLMCalls int) *messageGenerationRunner {
	return &messageGenerationRunner{
		service:     &Service{llmClient: gateway},
		startedAt:   time.Now(),
		maxLLMCalls: maxLLMCalls,
		usage:       &messageUsageAccumulator{},
	}
}

func TestGenerateWithRetryRecoversFromTransientUpstreamError(t *testing.T) {
	configureFastRetry(t)

	gateway := &retryTestGateway{
		generateErrors: []error{
			&llm.UpstreamError{StatusCode: 500, Message: "internal server error"},
			&llm.UpstreamError{StatusCode: 429, Message: "rate limited"},
		},
	}
	runner := newRetryTestRunner(gateway, 6)
	input := llm.GenerateInput{Messages: []llm.Message{{Role: "user", Content: "continue"}}}

	output, err := runner.generateWithRetry(context.Background(), input, input.Messages)
	if err != nil {
		t.Fatalf("transient 5xx/429 failures must be retried to success, got %v", err)
	}
	if output == nil || output.Text != "ok" {
		t.Fatalf("expected successful output, got %#v", output)
	}
	if gateway.generateCalls != 3 || runner.llmRequestCount != 3 {
		t.Fatalf("expected 3 attempts, got gateway=%d runner=%d", gateway.generateCalls, runner.llmRequestCount)
	}
}

func TestGenerateWithRetryDoesNotRetryClientErrors(t *testing.T) {
	configureFastRetry(t)

	gateway := &retryTestGateway{
		generateErrors: []error{
			&llm.UpstreamError{StatusCode: 400, Message: "invalid request"},
		},
	}
	runner := newRetryTestRunner(gateway, 6)
	input := llm.GenerateInput{Messages: []llm.Message{{Role: "user", Content: "continue"}}}

	_, err := runner.generateWithRetry(context.Background(), input, input.Messages)
	if err == nil {
		t.Fatal("4xx rejection must surface immediately")
	}
	if gateway.generateCalls != 1 {
		t.Fatalf("4xx must not be retried, got %d attempts", gateway.generateCalls)
	}
}

func TestGenerateWithRetryStopsWhenBudgetExhausted(t *testing.T) {
	configureFastRetry(t)

	gateway := &retryTestGateway{
		generateErrors: []error{
			&llm.UpstreamError{StatusCode: 500, Message: "internal server error"},
		},
	}
	runner := newRetryTestRunner(gateway, 2)
	runner.llmRequestCount = 2 // 预算已耗尽
	input := llm.GenerateInput{Messages: []llm.Message{{Role: "user", Content: "continue"}}}

	_, err := runner.generateWithRetry(context.Background(), input, input.Messages)
	if err == nil {
		t.Fatal("budget-exhausted failure must surface")
	}
	if gateway.generateCalls != 0 {
		t.Fatalf("no attempt is allowed without budget, got %d", gateway.generateCalls)
	}
}

func TestGenerateWithRetryNeverRetriesObservableAttempt(t *testing.T) {
	configureFastRetry(t)

	// 失败尝试若已向客户端发出过任何可见事件（observation 已置位），重试会造成重复输出，
	// 必须放弃。这里直接验证判定互斥；generate 内部每次尝试都会重建 observation。
	observation := &generationAttemptObservation{}
	if !observation.canRetry(&llm.UpstreamError{StatusCode: 500}, shouldRetryGenerationAttempt) {
		t.Fatal("clean failed attempt must be retryable")
	}
	observation.markObservable()
	if observation.canRetry(&llm.UpstreamError{StatusCode: 500}, shouldRetryGenerationAttempt) {
		t.Fatal("observable attempt must never be retryable")
	}
}

func TestShouldRetryGenerationAttemptClassification(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "server error", err: &llm.UpstreamError{StatusCode: 500}, want: true},
		{name: "bad gateway", err: &llm.UpstreamError{StatusCode: 502}, want: true},
		{name: "rate limited", err: &llm.UpstreamError{StatusCode: 429}, want: true},
		{name: "request timeout", err: &llm.UpstreamError{StatusCode: 408}, want: true},
		{name: "client error", err: &llm.UpstreamError{StatusCode: 400}, want: false},
		{name: "accepted interruption", err: llm.MarkRequestAccepted(errors.New("stream cut")), want: false},
		{name: "canceled", err: context.Canceled, want: false},
		{name: "unexpected eof", err: fmt.Errorf("read: %w", io.ErrUnexpectedEOF), want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldRetryGenerationAttempt(test.err); got != test.want {
				t.Fatalf("shouldRetryGenerationAttempt(%v) = %v, want %v", test.err, got, test.want)
			}
		})
	}
}
