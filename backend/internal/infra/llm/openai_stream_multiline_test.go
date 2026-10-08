package llm

import (
	"errors"
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
