package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

func traceSummaryFixture() *model.MessageProcessTrace {
	toolPayload := `{"tool_calls":[{"tool_call_id":"call_1","name":"web_search","status":"success","latency_ms":820,"input_preview":"检索","output_preview":"三个结果","input":"完整输入","input_detail":"输入详情","output":"完整输出","output_text":"正文","output_detail":"输出详情","output_presentation":{"kind":"search"}}]}`
	think := strings.Repeat("中文思考", 100)
	return &model.MessageProcessTrace{
		Enabled: true, Status: messageTraceStatusCompleted,
		Process:       &model.MessageTraceBlock{Title: "处理完成", PayloadJSON: `{"prompt_trace":{"mode":"full"}}`},
		PromptTrace:   &model.MessagePromptTrace{Mode: "full"},
		Tools:         &model.MessageTraceBlock{Title: "工具", PayloadJSON: toolPayload},
		UpstreamThink: &model.MessageTraceBlock{Title: "模型思考", ContentMarkdown: think, PayloadJSON: `{"reasoning":{}}`},
		Events: []model.MessageTraceEvent{
			{EventID: "process", Phase: messageTraceTypeProcess, Stage: messageTraceStageProcess},
			{EventID: "think", Phase: messageTraceTypeUpstreamThink, Stage: messageTraceStageThink, Summary: "思考", ContentMarkdown: think, PayloadJSON: `{"reasoning":{}}`},
			{EventID: "tool", Phase: messageTraceTypeTools, Stage: messageTraceStageTool, ContentMarkdown: "调用 web_search", PayloadJSON: toolPayload},
			{EventID: "legacy-tool", EventType: "tool", PayloadJSON: "not json"},
		},
	}
}

func TestSummarizeMessageProcessTracesKeepsWhatCollapsedRowsNeed(t *testing.T) {
	original := traceSummaryFixture()
	before, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	items := []model.Message{{Role: "assistant", Status: "success", ProcessTrace: original}}
	SummarizeMessageProcessTraces(items)
	summary := items[0].ProcessTrace
	if !summary.DetailOmitted || summary.Process != original.Process || summary.PromptTrace != original.PromptTrace {
		t.Fatalf("摘要应保留处理块与上下文规划: %#v", summary)
	}
	ids := []string{}
	for _, event := range summary.Events {
		ids = append(ids, event.EventID)
	}
	if strings.Join(ids, ",") != "think,tool,legacy-tool" {
		t.Fatalf("摘要事件顺序错误: %v", ids)
	}
	for _, text := range []string{summary.Events[0].ContentMarkdown, summary.UpstreamThink.ContentMarkdown} {
		if !utf8.ValidString(text) || text != strings.Repeat("中文思考", 20) {
			t.Fatalf("中文摘要未按字符截断: %q", text)
		}
	}
	if summary.Events[0].PayloadJSON != "" || summary.UpstreamThink.PayloadJSON != "" || summary.Events[0].Summary != "思考" {
		t.Fatal("思考摘要字段错误")
	}
	for _, payload := range []string{summary.Events[1].PayloadJSON, summary.Tools.PayloadJSON} {
		var decoded struct {
			ToolCalls []map[string]any `json:"tool_calls"`
		}
		if err := json.Unmarshal([]byte(payload), &decoded); err != nil || len(decoded.ToolCalls) != 1 {
			t.Fatalf("工具载荷无法解析: %v %s", err, payload)
		}
		call := decoded.ToolCalls[0]
		for _, key := range traceSummaryToolCallDetailKeys {
			if _, present := call[key]; present {
				t.Fatalf("摘要仍含工具详情 %s", key)
			}
		}
		if call["tool_call_id"] != "call_1" || call["name"] != "web_search" || call["status"] != "success" || call["latency_ms"] != float64(820) || call["input_preview"] != "检索" || call["output_preview"] != "三个结果" {
			t.Fatalf("工具摘要丢失展示字段: %v", call)
		}
	}
	if summary.Events[1].ContentMarkdown != "调用 web_search" || summary.Events[2].PayloadJSON != "not json" {
		t.Fatal("工具历史兼容字段丢失")
	}
	after, _ := json.Marshal(original)
	if string(before) != string(after) {
		t.Fatal("原始轨迹被改写")
	}
	SummarizeMessageProcessTraces(items)
	if items[0].ProcessTrace != summary {
		t.Fatal("重复摘要应保持幂等")
	}
}

func TestSummarizeMessageProcessTracesPreservesTextRounds(t *testing.T) {
	started := time.Date(2026, 10, 20, 8, 0, 0, 0, time.UTC)
	ended := started.Add(time.Second)
	trace := traceSummaryFixture()
	for index, event := range []model.MessageTraceEvent{
		{EventID: "text-1", EventType: "text", RoundID: "round-1", ContentMarkdown: strings.Repeat("中间正文", 100)},
		{EventID: "text-2", Stage: "text", RoundID: "round-2", ContentMarkdown: "第二轮正文"},
		{EventID: "text-3", Phase: "text", RoundID: "round-3", ContentMarkdown: ""},
	} {
		event.Seq = 5 + index
		event.ParentEventID = "tool"
		event.Status = messageTraceStatusCompleted
		event.StartedAt, event.EndedAt, event.UpdatedAt = started, &ended, ended
		trace.Events = append(trace.Events, event)
	}
	before, _ := json.Marshal(trace)
	summary := summarizeMessageProcessTrace(trace)
	if len(summary.Events) != 6 {
		t.Fatalf("text 轮次被过滤: %#v", summary.Events)
	}
	for index := 0; index < 3; index++ {
		original, actual := trace.Events[4+index], summary.Events[3+index]
		expected := original
		expected.ContentMarkdown = truncateTraceRunes(original.ContentMarkdown, traceSummaryThinkRunes)
		expected.PayloadJSON = ""
		if !reflect.DeepEqual(expected, actual) {
			t.Fatalf("text 身份、顺序或时间改变: %#v", actual)
		}
	}
	after, _ := json.Marshal(trace)
	if string(before) != string(after) {
		t.Fatal("摘要修改了原始 text 事件")
	}
}

func TestSummarizeMessageProcessTracesSkipsUnfinishedMessages(t *testing.T) {
	for _, status := range []string{"pending", "running", "streaming", "error", "interrupted", "blocked", "canceled"} {
		trace := traceSummaryFixture()
		items := []model.Message{{Role: "assistant", Status: status, ProcessTrace: trace}}
		SummarizeMessageProcessTraces(items)
		if items[0].ProcessTrace != trace || trace.DetailOmitted {
			t.Fatalf("%s 不应摘要", status)
		}
	}
	items := []model.Message{{Role: "user", Status: "success", ProcessTrace: traceSummaryFixture()}, {Role: "assistant", Status: "success"}}
	original := items[0].ProcessTrace
	SummarizeMessageProcessTraces(items)
	if items[0].ProcessTrace != original || items[1].ProcessTrace != nil {
		t.Fatal("非助手或空轨迹处理错误")
	}
}

func TestSlimToolTracePayloadPreservesLegacyPayload(t *testing.T) {
	for _, value := range []string{"", " ", "not json", "null", `{"other":true}`, `{"tool_calls":"legacy"}`} {
		if actual := slimToolTracePayload(value); actual != value {
			t.Fatalf("历史载荷改变: %q", actual)
		}
	}
	for _, value := range []string{"", "中文", strings.Repeat("字", 80)} {
		if truncateTraceRunes(value, 80) != value {
			t.Fatal("未超限正文被修改")
		}
	}
}

type traceSummaryRepository struct {
	repository.ConversationRepository
	message     model.Message
	rows        []model.MessageTrace
	events      []model.MessageTraceEventRow
	lookupErr   error
	traceErr    error
	lookupCalls int
	traceCalls  int
}

func (r *traceSummaryRepository) GetMessageByPublicIDForUser(_ context.Context, userID uint, publicID string) (*model.Message, error) {
	r.lookupCalls++
	if r.lookupErr != nil {
		return nil, r.lookupErr
	}
	if userID != r.message.UserID || publicID != r.message.PublicID {
		return nil, repository.ErrNotFound
	}
	item := r.message
	return &item, nil
}

func (r *traceSummaryRepository) ListConversationMessageTracesByMessageIDs(_ context.Context, ids []uint) ([]model.MessageTrace, error) {
	r.traceCalls++
	if len(ids) != 1 || ids[0] != r.message.ID {
		panic("轨迹读取目标不匹配")
	}
	return r.rows, r.traceErr
}

func (r *traceSummaryRepository) ListConversationMessageTraceEventsByMessageIDs(_ context.Context, ids []uint) ([]model.MessageTraceEventRow, error) {
	r.traceCalls++
	if len(ids) != 1 || ids[0] != r.message.ID {
		panic("事件读取目标不匹配")
	}
	return r.events, nil
}

func TestGetMessageProcessTraceReturnsFullTrace(t *testing.T) {
	text := strings.Repeat("完整中间正文", 100)
	repo := &traceSummaryRepository{
		message: model.Message{ID: 41, UserID: 9, PublicID: "message_trace", Role: "assistant", Status: "success"},
		rows:    []model.MessageTrace{{MessageID: 41, TraceType: messageTraceTypeUpstreamThink, ContentMarkdown: text, Status: messageTraceStatusCompleted}},
		events:  []model.MessageTraceEventRow{{MessageID: 41, EventID: "text-1", EventType: "text", RoundID: "round-1", ContentMarkdown: text, Seq: 1, Status: messageTraceStatusCompleted}},
	}
	service := &Service{cfg: config.NewRuntime(config.Config{ProcessTraceEnabled: true}), repo: repo}
	trace, err := service.GetMessageProcessTrace(context.Background(), 9, " message_trace ")
	if err != nil || trace == nil || trace.DetailOmitted || trace.UpstreamThink.ContentMarkdown != text || len(trace.Events) != 1 || trace.Events[0].ContentMarkdown != text {
		t.Fatalf("详情未保留全文: %#v %v", trace, err)
	}
	items := []model.Message{{Role: "assistant", Status: "success", ProcessTrace: trace}}
	SummarizeMessageProcessTraces(items)
	trace, err = service.GetMessageProcessTrace(context.Background(), 9, "message_trace")
	if err != nil || trace.Events[0].ContentMarkdown != text || repo.events[0].ContentMarkdown != text {
		t.Fatal("摘要污染详情或持久化原文")
	}
}

func TestGetMessageProcessTraceOwnershipAndBlockedBoundaries(t *testing.T) {
	for _, test := range []struct {
		name                   string
		userID                 uint
		publicID, role, status string
		enabled                bool
		wantErr                error
		wantLookup             int
	}{
		{"其他用户", 10, "message_trace", "assistant", "success", true, ErrMessageNotFound, 1},
		{"未知消息", 9, "missing", "assistant", "success", true, ErrMessageNotFound, 1},
		{"空编号", 9, " ", "assistant", "success", true, ErrMessageNotFound, 0},
		{"审核拦截", 9, "message_trace", "assistant", " BLOCKED ", true, nil, 1},
		{"非助手", 9, "message_trace", "user", "success", true, nil, 1},
		{"功能关闭", 9, "message_trace", "assistant", "success", false, nil, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := &traceSummaryRepository{message: model.Message{ID: 41, UserID: 9, PublicID: "message_trace", Role: test.role, Status: test.status}}
			service := &Service{cfg: config.NewRuntime(config.Config{ProcessTraceEnabled: test.enabled}), repo: repo}
			trace, err := service.GetMessageProcessTrace(context.Background(), test.userID, test.publicID)
			if !errors.Is(err, test.wantErr) || trace != nil || repo.lookupCalls != test.wantLookup || repo.traceCalls != 0 {
				t.Fatalf("边界泄露轨迹: %#v %v %#v", trace, err, repo)
			}
		})
	}
	failure := errors.New("测试仓储错误")
	repo := &traceSummaryRepository{message: model.Message{ID: 41, UserID: 9, PublicID: "message_trace", Role: "assistant"}}
	service := &Service{cfg: config.NewRuntime(config.Config{ProcessTraceEnabled: true}), repo: repo}
	repo.lookupErr = failure
	if _, err := service.GetMessageProcessTrace(context.Background(), 9, "message_trace"); !errors.Is(err, failure) {
		t.Fatal("查询错误未透传")
	}
	repo.lookupErr, repo.traceErr = nil, failure
	if _, err := service.GetMessageProcessTrace(context.Background(), 9, "message_trace"); !errors.Is(err, failure) {
		t.Fatal("轨迹错误未透传")
	}
	repo.traceErr = nil
	if trace, err := service.GetMessageProcessTrace(context.Background(), 9, "message_trace"); err != nil || trace != nil {
		t.Fatal("无轨迹应返回 nil")
	}
}
