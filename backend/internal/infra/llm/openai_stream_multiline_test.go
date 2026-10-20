package llm

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	portllm "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

// 部分上游以 pretty-print 多行 JSON 发送 SSE 事件（后续行没有 data: 前缀）。
// 消费器必须把续行拼回当前事件，否则流内 error 对象会被裁成非法 JSON，
// 真实的上游错误（如服务器过载）被误报为“HTTP 200 协议不兼容”。
func TestConsumeOpenAIChatStreamParsesMultiLineErrorPayload(t *testing.T) {
	rawStream := strings.Join([]string{
		`data: {"id":"resp_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":" think"}}],"finish_reason":null}`,
		``,
		`data: {`,
		`  "error": {`,
		`    "message": "Our servers are currently overloaded. Please try again later.",`,
		`    "type": "upstream_error"`,
		`  }`,
		`}`,
		``,
	}, "\n")

	result := &portllm.GenerateOutput{}
	err := consumeOpenAIGenerateStream(portllm.EndpointChatCompletions, portllm.AdapterOpenAIChatCompletions, strings.NewReader(rawStream), result, nil, false)
	if err == nil {
		t.Fatal("expected in-stream upstream error to propagate")
	}
	var upstreamErr *portllm.UpstreamError
	if !errors.As(err, &upstreamErr) {
		t.Fatalf("expected UpstreamError, got %T: %v", err, err)
	}
	if !strings.Contains(upstreamErr.Message, "Our servers are currently overloaded") {
		t.Fatalf("expected upstream overload message, got %q", upstreamErr.Message)
	}
}

func TestConsumeOpenAIChatStreamSkipsSSEComments(t *testing.T) {
	rawStream := strings.Join([]string{
		`: ping`,
		``,
		`data: {"id":"resp_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	result := &portllm.GenerateOutput{}
	if err := consumeOpenAIGenerateStream(portllm.EndpointChatCompletions, portllm.AdapterOpenAIChatCompletions, strings.NewReader(rawStream), result, nil, false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Text != "hi" {
		t.Fatalf("unexpected text %q", result.Text)
	}
}

// 解析失败时必须把出错的数据块一并带出，否则用户只能看到“格式不兼容”而看不到返回了什么。
func TestConsumeOpenAIChatStreamReportsUnparsableChunkPayload(t *testing.T) {
	rawStream := strings.Join([]string{
		`data: {"choices":[`,
		``,
	}, "\n")

	result := &portllm.GenerateOutput{}
	err := consumeOpenAIGenerateStream(portllm.EndpointChatCompletions, portllm.AdapterOpenAIChatCompletions, strings.NewReader(rawStream), result, nil, false)
	if err == nil {
		t.Fatal("expected parse failure")
	}
	if !strings.Contains(err.Error(), "invalid stream chunk") {
		t.Fatalf("expected chunk parse error, got %v", err)
	}
	if !strings.Contains(err.Error(), "choices") {
		t.Fatalf("expected offending payload in error, got %v", err)
	}
}

// 建流后的失败必须显式标记，不能继续借用 200 当作“响应格式不兼容”。
func TestAttachStreamUpstreamDebugMarksSuccessfulHTTPFailure(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://example.com/v1/chat/completions", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	debug := upstreamDebugSnapshot(req, nil, &http.Response{StatusCode: http.StatusOK}, []byte("data: {\"choices\":[]}\n\n"))

	attached := attachStreamUpstreamDebug(errors.New("stream idle timeout: no data received for 2m0s"), debug)
	var upstreamErr *portllm.UpstreamError
	if !errors.As(attached, &upstreamErr) {
		t.Fatalf("expected UpstreamError, got %T: %v", attached, attached)
	}
	if !upstreamErr.StreamInterrupted {
		t.Fatal("expected stream interruption flag")
	}
	if upstreamErr.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status %d", upstreamErr.StatusCode)
	}
	if !strings.Contains(upstreamErr.Message, "stream idle timeout") {
		t.Fatalf("expected real cause, got %q", upstreamErr.Message)
	}
}
