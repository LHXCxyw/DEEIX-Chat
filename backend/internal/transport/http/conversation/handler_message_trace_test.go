package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	appcompact "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/compact"
	appconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/conversation"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

type messageTraceHTTPRepository struct {
	repository.ConversationRepository
	status     string
	role       string
	emptyTrace bool
	lookupErr  error
	traceCalls int
}

func (r *messageTraceHTTPRepository) GetMessageByPublicIDForUser(_ context.Context, userID uint, publicID string) (*model.Message, error) {
	if r.lookupErr != nil {
		return nil, r.lookupErr
	}
	if userID != 9 || publicID != "message_trace" {
		return nil, repository.ErrNotFound
	}
	return &model.Message{ID: 41, UserID: 9, Role: r.role, Status: r.status}, nil
}

func (r *messageTraceHTTPRepository) ListConversationMessageTracesByMessageIDs(context.Context, []uint) ([]model.MessageTrace, error) {
	r.traceCalls++
	return nil, nil
}

func (r *messageTraceHTTPRepository) ListConversationMessageTraceEventsByMessageIDs(context.Context, []uint) ([]model.MessageTraceEventRow, error) {
	r.traceCalls++
	if r.emptyTrace {
		return nil, nil
	}
	return []model.MessageTraceEventRow{{MessageID: 41, EventID: "text-1", EventType: "text", RoundID: "round-1", Seq: 1, ContentMarkdown: strings.Repeat("完整正文", 100)}}, nil
}

func TestGetMessageProcessTraceHTTPBoundaries(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name                  string
		userID                uint
		id, status            string
		lookupErr             error
		wantStatus, wantCalls int
		role                  string
		disabled, emptyTrace  bool
	}{
		{name: "所有者完整详情", userID: 9, id: "message_trace", status: "success", role: "assistant", wantStatus: http.StatusOK, wantCalls: 2},
		{name: "其他用户", userID: 10, id: "message_trace", status: "success", role: "assistant", wantStatus: http.StatusNotFound},
		{name: "未知消息", userID: 9, id: "missing", status: "success", role: "assistant", wantStatus: http.StatusNotFound},
		{name: "空编号", userID: 9, id: " ", status: "success", role: "assistant", wantStatus: http.StatusBadRequest},
		{name: "审核拦截", userID: 9, id: "message_trace", status: " BLOCKED ", role: "assistant", wantStatus: http.StatusOK},
		{name: "非助手", userID: 9, id: "message_trace", status: "success", role: "user", wantStatus: http.StatusOK},
		{name: "功能关闭", userID: 9, id: "message_trace", status: "success", role: "assistant", disabled: true, wantStatus: http.StatusOK},
		{name: "功能关闭仍校验归属", userID: 10, id: "message_trace", status: "success", role: "assistant", disabled: true, wantStatus: http.StatusNotFound},
		{name: "没有轨迹", userID: 9, id: "message_trace", status: "success", role: "assistant", emptyTrace: true, wantStatus: http.StatusOK, wantCalls: 2},
		{name: "仓储错误", userID: 9, id: "message_trace", status: "success", role: "assistant", lookupErr: errors.New("测试读取错误"), wantStatus: http.StatusInternalServerError},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := &messageTraceHTTPRepository{status: test.status, role: test.role, emptyTrace: test.emptyTrace, lookupErr: test.lookupErr}
			service := appconversation.NewServiceWithRuntime(appconversation.Dependencies{
				Config: config.NewRuntime(config.Config{ProcessTraceEnabled: !test.disabled}), Repository: repo, CompactService: &appcompact.Service{},
			})
			defer service.Close()
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest(http.MethodGet, "/messages/message_trace/trace", nil)
			c.Params = gin.Params{{Key: "id", Value: test.id}}
			c.Set(middleware.ContextKeyUserID, test.userID)
			(&Handler{service: service}).GetMessageProcessTrace(c)
			if w.Code != test.wantStatus || repo.traceCalls != test.wantCalls {
				t.Fatalf("边界响应错误: %d %s，读取次数 %d", w.Code, w.Body.String(), repo.traceCalls)
			}
			if w.Code == http.StatusOK {
				var envelope struct {
					Data MessageProcessTraceDetailResponse `json:"data"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if test.wantCalls == 0 || test.emptyTrace {
					if envelope.Data.ProcessTrace != nil || !strings.Contains(w.Body.String(), `"processTrace":null`) {
						t.Fatal("不可用的轨迹应显式返回 null")
					}
				} else if trace := envelope.Data.ProcessTrace; trace == nil || trace.DetailOmitted || len(trace.Events) != 1 || trace.Events[0].ContentMarkdown != strings.Repeat("完整正文", 100) {
					t.Fatalf("详情响应丢失正文: %#v", trace)
				}
			}
		})
	}
}

func TestMessageProcessTraceSummaryResponseContract(t *testing.T) {
	trace := &model.MessageProcessTrace{DetailOmitted: true, Events: []model.MessageTraceEvent{{EventID: "text-1", EventType: "text", RoundID: "round-1", Seq: 2, ContentMarkdown: "正文摘要"}}}
	response := toMessageProcessTraceResponse(trace)
	if !response.DetailOmitted || len(response.Events) != 1 || response.Events[0].EventID != "text-1" || response.Events[0].RoundID != "round-1" || response.Events[0].Seq != 2 {
		t.Fatalf("摘要契约错误: %#v", response)
	}
	data, err := json.Marshal(response)
	if err != nil || !strings.Contains(string(data), `"detailOmitted":true`) {
		t.Fatalf("摘要标记未序列化: %s %v", data, err)
	}
}

type messageTraceListHTTPRepository struct {
	repository.ConversationRepository
	message model.Message
	events  []model.MessageTraceEventRow
	path    string
}

func (r *messageTraceListHTTPRepository) GetConversationByPublicID(_ context.Context, publicID string, userID uint) (*model.Conversation, error) {
	if publicID != "conversation_trace" || userID != 9 {
		return nil, repository.ErrNotFound
	}
	return &model.Conversation{ID: 7, UserID: 9, PublicID: publicID}, nil
}

func (r *messageTraceListHTTPRepository) GetConversationByUser(_ context.Context, conversationID, userID uint) (*model.Conversation, error) {
	if conversationID != 7 || userID != 9 {
		return nil, repository.ErrNotFound
	}
	return &model.Conversation{ID: 7, UserID: 9}, nil
}

func (r *messageTraceListHTTPRepository) ListMessages(context.Context, uint, int, int) ([]model.Message, int64, error) {
	r.path = "page"
	return []model.Message{r.message}, 1, nil
}

func (r *messageTraceListHTTPRepository) ListRecentMessages(context.Context, uint, int) ([]model.Message, int64, error) {
	r.path = "tail"
	return []model.Message{r.message}, 1, nil
}

func (r *messageTraceListHTTPRepository) ListMessagesBeforeID(context.Context, uint, uint, int) ([]model.Message, int64, error) {
	r.path = "before"
	return []model.Message{r.message}, 1, nil
}

func (r *messageTraceListHTTPRepository) GetUserMessageFeedbackMap(context.Context, uint, []uint) (map[uint]string, error) {
	return nil, nil
}

func (r *messageTraceListHTTPRepository) GetMessageFeedbackCounts(context.Context, []uint) (map[uint]map[string]int64, error) {
	return nil, nil
}

func (r *messageTraceListHTTPRepository) GetMessageUIStateMap(context.Context, uint, []uint) (map[uint]map[string]string, error) {
	return nil, nil
}

func (r *messageTraceListHTTPRepository) ListConversationMessageTracesByMessageIDs(context.Context, []uint) ([]model.MessageTrace, error) {
	return nil, nil
}

func (r *messageTraceListHTTPRepository) ListConversationMessageTraceEventsByMessageIDs(context.Context, []uint) ([]model.MessageTraceEventRow, error) {
	return r.events, nil
}

func TestListMessagesTraceSummaryHTTPCompatibility(t *testing.T) {
	gin.SetMode(gin.TestMode)
	started := time.Date(2026, 10, 20, 8, 0, 0, 0, time.UTC)
	ended := started.Add(time.Second)
	text := strings.Repeat("中文正文", 100)
	for _, status := range []string{"success", "running", "error", "interrupted"} {
		for _, path := range []struct{ name, query string }{{"page", ""}, {"tail", "&tail=true"}, {"before", "&before_id=99"}} {
			t.Run(status+"/"+path.name, func(t *testing.T) {
				repo := &messageTraceListHTTPRepository{
					message: model.Message{ID: 41, ConversationID: 7, UserID: 9, PublicID: "message_trace", Role: "assistant", Status: status, Content: "二改后的最终正文", EditedAt: &ended},
				}
				for index, kind := range []struct{ eventType, stage, phase string }{{"text", "", ""}, {"", "text", ""}, {"", "", "text"}, {"think", "think", "upstream_think"}} {
					repo.events = append(repo.events, model.MessageTraceEventRow{
						MessageID: 41, EventID: "event-" + string(rune('1'+index)), EventType: kind.eventType, Stage: kind.stage, Phase: kind.phase,
						RoundID: "round-" + string(rune('1'+index)), ParentEventID: "tool-parent", Seq: index + 5,
						Status: "completed", ContentMarkdown: text, StartedAt: started, EndedAt: &ended, UpdatedAt: ended,
					})
				}
				originalMessage := repo.message
				originalEvents := append([]model.MessageTraceEventRow(nil), repo.events...)
				service := appconversation.NewServiceWithRuntime(appconversation.Dependencies{
					Config: config.NewRuntime(config.Config{ProcessTraceEnabled: true}), Repository: repo, CompactService: &appcompact.Service{},
				})
				defer service.Close()
				for _, query := range []string{"", "&trace=full", "&trace=summary", ""} {
					w := httptest.NewRecorder()
					c, _ := gin.CreateTestContext(w)
					c.Request = httptest.NewRequest(http.MethodGet, "/conversations/conversation_trace/messages?page_size=20"+path.query+query, nil)
					c.Params = gin.Params{{Key: "id", Value: "conversation_trace"}}
					c.Set(middleware.ContextKeyUserID, uint(9))
					(&Handler{service: service}).ListMessages(c)
					if w.Code != http.StatusOK || repo.path != path.name {
						t.Fatalf("列表路径错误: %d %s %s", w.Code, repo.path, w.Body.String())
					}
					var envelope struct {
						Data struct {
							Total   int64             `json:"total"`
							Results []MessageResponse `json:"results"`
						} `json:"data"`
					}
					if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
						t.Fatal(err)
					}
					if envelope.Data.Total != 1 || len(envelope.Data.Results) != 1 {
						t.Fatalf("列表数量错误: %#v", envelope.Data)
					}
					message := envelope.Data.Results[0]
					if message.Content != originalMessage.Content || message.EditedAt == nil || !message.EditedAt.Equal(ended) {
						t.Fatal("摘要影响二改后的正文或编辑时间")
					}
					wantSummary := query == "&trace=summary" && status == "success"
					trace := message.ProcessTrace
					if trace == nil || trace.DetailOmitted != wantSummary || len(trace.Events) != len(originalEvents) {
						t.Fatalf("摘要开关或事件数量错误: %#v", trace)
					}
					for index, event := range trace.Events {
						original := originalEvents[index]
						wantText := text
						if wantSummary {
							wantText = string([]rune(text)[:80])
						}
						if event.ContentMarkdown != wantText || event.EventID != original.EventID || event.EventType != original.EventType || event.Stage != original.Stage || event.Phase != original.Phase || event.RoundID != original.RoundID || event.ParentEventID != original.ParentEventID || event.Seq != original.Seq || event.Status != original.Status || !event.StartedAt.Equal(started) || event.EndedAt == nil || !event.EndedAt.Equal(ended) || !event.UpdatedAt.Equal(ended) {
							t.Fatalf("事件身份、轮次、顺序、时间或正文错误: %#v", event)
						}
					}
					if !reflect.DeepEqual(repo.events, originalEvents) || !reflect.DeepEqual(repo.message, originalMessage) {
						t.Fatal("响应摘要污染仓储原始数据")
					}
				}
			})
		}
	}
}
