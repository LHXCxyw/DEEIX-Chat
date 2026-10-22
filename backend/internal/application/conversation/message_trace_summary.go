package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

// traceSummaryThinkRunes 保留思考与中间正文的开头，避免摘要丢失轮次展示。
const traceSummaryThinkRunes = 80

// traceSummaryToolCallDetailKeys 仅移除展开使用的大字段，保留预览、身份、状态和耗时。
var traceSummaryToolCallDetailKeys = []string{"input", "input_detail", "output", "output_text", "output_detail", "output_presentation"}

// SummarizeMessageProcessTraces 只替换成功助手消息的响应轨迹，不改写原始轨迹或持久化数据。
// 进行中、失败和中断消息保留完整轨迹及错误详情。
func SummarizeMessageProcessTraces(items []model.Message) {
	for index := range items {
		item := &items[index]
		if item.Role != "assistant" || !strings.EqualFold(strings.TrimSpace(item.Status), "success") {
			continue
		}
		item.ProcessTrace = summarizeMessageProcessTrace(item.ProcessTrace)
	}
}

func summarizeMessageProcessTrace(trace *model.MessageProcessTrace) *model.MessageProcessTrace {
	if trace == nil || trace.DetailOmitted {
		return trace
	}
	summary := *trace
	summary.DetailOmitted = true
	summary.UpstreamThink = summarizeThinkTraceBlock(trace.UpstreamThink)
	summary.Tools = summarizeToolTraceBlock(trace.Tools)
	summary.Events = make([]model.MessageTraceEvent, 0, len(trace.Events))
	for _, event := range trace.Events {
		switch {
		case isTextTraceEvent(event), isThinkTraceEvent(event):
			event.ContentMarkdown = truncateTraceRunes(event.ContentMarkdown, traceSummaryThinkRunes)
			event.PayloadJSON = ""
		case isToolTraceEvent(event):
			event.PayloadJSON = slimToolTracePayload(event.PayloadJSON)
		default:
			// 处理阶段事件与 Process 块重复；本地 text 事件必须保留身份、顺序与时间。
			continue
		}
		summary.Events = append(summary.Events, event)
	}
	return &summary
}

func isTextTraceEvent(event model.MessageTraceEvent) bool {
	return event.Stage == "text" || event.Phase == "text" || event.EventType == "text"
}

func isThinkTraceEvent(event model.MessageTraceEvent) bool {
	return event.Stage == messageTraceStageThink || event.Phase == messageTraceTypeUpstreamThink || event.EventType == messageTraceStageThink
}

func isToolTraceEvent(event model.MessageTraceEvent) bool {
	return event.Stage == messageTraceStageTool || event.Phase == messageTraceTypeTools || event.EventType == messageTraceStageTool
}

func summarizeThinkTraceBlock(block *model.MessageTraceBlock) *model.MessageTraceBlock {
	if block == nil {
		return nil
	}
	summary := *block
	summary.ContentMarkdown = truncateTraceRunes(block.ContentMarkdown, traceSummaryThinkRunes)
	summary.PayloadJSON = ""
	return &summary
}

func summarizeToolTraceBlock(block *model.MessageTraceBlock) *model.MessageTraceBlock {
	if block == nil {
		return nil
	}
	summary := *block
	summary.PayloadJSON = slimToolTracePayload(block.PayloadJSON)
	return &summary
}

// slimToolTracePayload 去掉工具完整输入输出；无法解析的历史载荷原样保留。
func slimToolTracePayload(payloadJSON string) string {
	if strings.TrimSpace(payloadJSON) == "" {
		return payloadJSON
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return payloadJSON
	}
	rawCalls, ok := payload["tool_calls"]
	if !ok {
		return payloadJSON
	}
	var calls []map[string]json.RawMessage
	if err := json.Unmarshal(rawCalls, &calls); err != nil {
		return payloadJSON
	}
	for _, call := range calls {
		for _, key := range traceSummaryToolCallDetailKeys {
			delete(call, key)
		}
	}
	encodedCalls, err := json.Marshal(calls)
	if err != nil {
		return payloadJSON
	}
	payload["tool_calls"] = encodedCalls
	encoded, err := json.Marshal(payload)
	if err != nil {
		return payloadJSON
	}
	return string(encoded)
}

func truncateTraceRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// GetMessageProcessTrace 返回当前用户助手消息的完整轨迹；非助手、无轨迹或 blocked 返回 nil。
func (s *Service) GetMessageProcessTrace(ctx context.Context, userID uint, messagePublicID string) (*model.MessageProcessTrace, error) {
	publicID := strings.TrimSpace(messagePublicID)
	if publicID == "" {
		return nil, ErrMessageNotFound
	}
	message, err := s.repo.GetMessageByPublicIDForUser(ctx, userID, publicID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrMessageNotFound
		}
		return nil, err
	}
	if message.Role != "assistant" || strings.EqualFold(strings.TrimSpace(message.Status), "blocked") {
		return nil, nil
	}
	items := []model.Message{*message}
	if err := s.hydrateMessageProcessTraces(ctx, items); err != nil {
		return nil, err
	}
	return items[0].ProcessTrace, nil
}
