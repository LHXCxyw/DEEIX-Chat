package conversation

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

type nativeInputTestStoreProvider struct {
	store objectstorage.Store
	opens int
}

func (p *nativeInputTestStoreProvider) Open(context.Context) (objectstorage.Store, error) {
	p.opens++
	return p.store, nil
}

func TestResolveNativeInputPolicy(t *testing.T) {
	for _, protocol := range []string{
		llm.AdapterAnthropicMessages, llm.AdapterGoogleGenerateContent,
		llm.AdapterOpenAIChatCompletions, llm.AdapterOpenAIResponses,
		llm.AdapterOpenRouterChat, llm.AdapterOpenRouterResponses, llm.AdapterXAIResponses,
	} {
		for _, declaration := range []struct {
			name         string
			capabilities string
			catalog      []string
		}{
			{name: "unknown"},
			{name: "text catalog", catalog: []string{"text"}},
			{name: "explicit text", capabilities: `{"inputModalities":["text"]}`, catalog: []string{"image", "pdf", "audio", "video"}},
		} {
			t.Run(protocol+"/"+declaration.name, func(t *testing.T) {
				route := channel.ResolvedRoute{Protocol: protocol, BaseURL: "https://relay.example.com/v1", ModelCapabilitiesJSON: declaration.capabilities, CatalogInputModalities: declaration.catalog}
				got := resolveNativeInputPolicy(&route)
				if got.PDF != (protocol != llm.AdapterXAIResponses) {
					t.Fatalf("协议 PDF 编码能力不应受声明影响: %+v", got)
				}
			})
		}
	}
}

func nativePDF(fileID string, size int64, pages int, current bool) AttachmentInput {
	return AttachmentInput{
		FileID: fileID, FileName: fileID + ".pdf", FileCategory: fileCategoryPDF, MimeType: "application/pdf",
		StoragePath: "files/" + fileID, FileSize: size, PageCount: pages, ExtractedText: "提取文本",
		ContextMode: fileContextModeFull, Current: current, MessageRole: "user",
	}
}

// 预算内越新的文件越优先；走检索、助手生成、过大的文件不原生发送；扫描件（无提取文本）可以原生发送。
func TestSelectNativeDocumentsPrefersNewestWithinBudget(t *testing.T) {
	retrieval := nativePDF("retrieval", 1024, 2, false)
	retrieval.ContextMode = fileContextModeRAG
	assistant := nativePDF("assistant", 1024, 2, false)
	assistant.MessageRole = "assistant"
	scanned := nativePDF("scanned", 1024, 3, false)
	scanned.ContextMode, scanned.ExtractedText = fileContextModeSkipped, ""
	tooLong := nativePDF("too_long_text", 1024, 3, false)
	tooLong.ContextMode = fileContextModeSkipped
	attachments := []AttachmentInput{
		nativePDF("oldest", 4*1024*1024, 10, false),
		retrieval, assistant, scanned, tooLong,
		nativePDF("huge", maxNativePDFTotalBytes+1, 1, false),
		nativePDF("recent", 3*1024*1024, 40, false),
		nativePDF("current", 2*1024*1024, 50, true),
	}

	selected := selectNativeInputs(attachments, nativeInputPolicy{PDF: true})

	ids := make([]string, 0, len(selected))
	for _, att := range selected {
		ids = append(ids, att.FileID)
	}
	// current(50 页)+recent(40 页)+scanned(3 页) 已占 93 页，oldest 的 10 页超出页数上限。
	if got := strings.Join(ids, ","); got != "current,recent,scanned" {
		t.Fatalf("selected = %q", got)
	}
	if len(selectNativeInputs(attachments, nativeInputPolicy{})) != 0 {
		t.Fatal("no native documents without PDF support")
	}
}

// 端到端：原生 PDF 随所属轮次发送并留文件名说明；不支持原生文档的路由（故障转移）退回文本。
func TestBuildMessageRoutePromptSendsNativePDFPerRoute(t *testing.T) {
	store := objectstorage.NewLocal(t.TempDir())
	if _, err := store.Put(t.Context(), "files/report", bytes.NewReader([]byte("%PDF-1.7 report")), objectstorage.PutOptions{ContentType: "application/pdf"}); err != nil {
		t.Fatalf("put pdf: %v", err)
	}
	service := &Service{storeProvider: &nativeInputTestStoreProvider{store: store}}
	report := nativePDF("report", int64(len("%PDF-1.7 report")), 2, true)
	input := messageRoutePromptInput{
		DomainMessages:    []model.Message{{Role: "user", Content: "总结这份报告"}},
		ConversationFiles: []AttachmentInput{report},
	}

	native, err := service.buildMessageRoutePrompt(t.Context(), &channel.ResolvedRoute{
		Protocol: llm.AdapterAnthropicMessages, CatalogInputModalities: []string{"text", "image", "pdf"},
	}, input)
	if err != nil {
		t.Fatalf("build native prompt: %v", err)
	}
	parts := native.Messages[len(native.Messages)-1].Parts
	if len(parts) != 3 || parts[0].Kind != llm.ContentPartFile || parts[1].Kind != llm.ContentPartDocument || parts[2].Text != "总结这份报告" {
		t.Fatalf("expected file note, native document, then question, got %#v", parts)
	}
	if !strings.Contains(parts[0].Text, `<document source="report.pdf" access="native">`) || strings.Contains(parts[0].Text, "提取文本") {
		t.Fatalf("native files must be named without duplicating the extracted text, got %q", parts[0].Text)
	}
	if string(parts[1].Data) != "%PDF-1.7 report" || parts[1].MimeType != "application/pdf" || parts[1].PageCount != 2 {
		t.Fatalf("unexpected native document part: %#v", parts[1])
	}
	// 没有动态上下文时整条消息都会在下一轮原样重现，缓存断点落在最后一个内容块上，覆盖原生文档。
	if parts[1].CacheControl != nil || parts[2].CacheControl == nil {
		t.Fatalf("expected the cache boundary after the native document, got %#v", parts)
	}

	fallback, err := service.buildMessageRoutePrompt(t.Context(), &channel.ResolvedRoute{
		Protocol: llm.AdapterXAIResponses, BaseURL: "https://relay.example.com/v1", CatalogInputModalities: []string{"text", "image", "pdf"},
	}, input)
	if err != nil {
		t.Fatalf("build fallback prompt: %v", err)
	}
	for _, part := range fallback.Messages[len(fallback.Messages)-1].Parts {
		if part.Kind == llm.ContentPartDocument {
			t.Fatalf("relay routes must not receive native documents, got %#v", part)
		}
	}
	if documents, _ := turnParts(t, fallback.Messages[len(fallback.Messages)-1]); !strings.Contains(documents, "提取文本") {
		t.Fatalf("relay routes fall back to extracted text, got %q", documents)
	}
}

// 当前、历史和动态上下文图片均不受输入模态声明影响。
func TestBuildMessageRoutePromptSendsImagesRegardlessOfDeclarations(t *testing.T) {
	store := objectstorage.NewLocal(t.TempDir())
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	if _, err := store.Put(t.Context(), "images/photo", bytes.NewReader(data), objectstorage.PutOptions{ContentType: "image/png"}); err != nil {
		t.Fatal(err)
	}
	service := &Service{storeProvider: &nativeInputTestStoreProvider{store: store}}
	for _, route := range []channel.ResolvedRoute{
		{Protocol: llm.AdapterOpenAIChatCompletions},
		{Protocol: llm.AdapterOpenAIChatCompletions, CatalogInputModalities: []string{"text"}},
		{Protocol: llm.AdapterOpenAIChatCompletions, ModelCapabilitiesJSON: `{"inputModalities":["text"]}`},
	} {
		t.Run(route.ModelCapabilitiesJSON+strings.Join(route.CatalogInputModalities, ","), func(t *testing.T) {
			for _, current := range []bool{false, true} {
				image := AttachmentInput{FileID: "photo", FileName: "photo.png", Kind: "image", MimeType: "image/png", StoragePath: "images/photo",
					ContextMode: fileContextModeDirectImage, Current: current, MessageRole: "user"}
				input := messageRoutePromptInput{
					DomainMessages:    []model.Message{{Role: "user", Content: "图里是什么", Attachments: `[{"file_id":"photo","kind":"image","mime_type":"image/png"}]`}},
					ConversationFiles: []AttachmentInput{image},
				}
				if current {
					input.DynamicContext.Attachments = []AttachmentInput{image}
				}
				plan, err := service.buildMessageRoutePrompt(t.Context(), &route, input)
				if err != nil {
					t.Fatal(err)
				}
				images := 0
				for _, message := range plan.Messages {
					for _, part := range message.Parts {
						if part.Kind == llm.ContentPartImage && len(part.Data) > 0 {
							images++
						}
						if strings.Contains(part.Text, `access="unsupported"`) {
							t.Fatalf("不应因模型声明产生 unsupported: %#v", message)
						}
					}
				}
				if images != 1 {
					t.Fatalf("current=%v: 图片应实际发送一次，得到 %d", current, images)
				}
			}
		})
	}
}

// 文件展示保留图片，只有协议无法编码的音视频归入 unsupported。
func TestAttachmentRouteTraceShowsNativeAndUnsupportedFiles(t *testing.T) {
	store := objectstorage.NewLocal(t.TempDir())
	if _, err := store.Put(t.Context(), "files/report", bytes.NewReader([]byte("%PDF-1.7")), objectstorage.PutOptions{ContentType: "application/pdf"}); err != nil {
		t.Fatalf("put pdf: %v", err)
	}
	provider := &nativeInputTestStoreProvider{store: store}
	service := &Service{storeProvider: provider}
	report := nativePDF("report", int64(len("%PDF-1.7")), 1, true)
	missing := nativePDF("missing", 1024, 1, true)
	photo := AttachmentInput{FileID: "photo", FileName: "photo.png", Kind: "image", MimeType: "image/png", ContextMode: fileContextModeDirectImage, Current: true, MessageRole: "user"}
	files := []AttachmentInput{report, missing, photo}
	cache := newNativeInputCache()

	pdfRoute := &channel.ResolvedRoute{Protocol: llm.AdapterAnthropicMessages, CatalogInputModalities: []string{"text", "pdf"}}
	trace := attachmentRouteTrace{fileMode: "auto", items: files}
	trace.resolve(t.Context(), service, pdfRoute, files, cache)

	groups := trace.payload.FileGroupRefs
	if len(groups.Native) != 1 || groups.Native[0].FileID != "report" {
		t.Fatalf("expected the readable PDF as native, got %#v", groups)
	}
	if len(groups.Adaptive) != 1 || groups.Adaptive[0].FileID != "missing" {
		t.Fatalf("an unreadable PDF falls back to extracted text, got %#v", groups)
	}
	if len(groups.Unsupported) != 0 || len(groups.DirectImages) != 1 || groups.DirectImages[0].FileID != "photo" {
		t.Fatalf("图片不应因模型声明被排除，得到 %#v", groups)
	}
	if stage := firstTraceStage(trace.payload); stage == nil || stage.IncludedCount != 3 || stage.SkippedCount != 0 {
		t.Fatalf("所有文件均应计入，得到 %#v", stage)
	}

	// 故障转移到另一条路由：重新判断，但已读取（或读取失败）的文件不再访问存储。
	opens := provider.opens
	relay := &channel.ResolvedRoute{Protocol: llm.AdapterXAIResponses, BaseURL: "https://relay.example.com/v1", CatalogInputModalities: []string{"text", "image", "pdf"}}
	trace.resolve(t.Context(), service, relay, files, cache)
	groups = trace.payload.FileGroupRefs
	if len(groups.Native) != 0 || len(groups.DirectImages) != 1 || len(groups.Adaptive) != 2 {
		t.Fatalf("relay route must show extracted text and direct images, got %#v", groups)
	}
	trace.resolve(t.Context(), service, pdfRoute, files, cache)
	if provider.opens != opens {
		t.Fatalf("cached native documents must not be read again, opens %d -> %d", opens, provider.opens)
	}
}

func TestReplaceProcessSectionUpdatesFileContextAfterFailover(t *testing.T) {
	recorder := &messageTraceRecorder{
		cfg:       config.Config{ProcessTraceEnabled: true},
		assistant: &model.Message{ID: 1, ConversationID: 2, UserID: 3, RunID: "run_1"},
	}
	files := []AttachmentInput{nativePDF("report", 1024, 1, true)}
	first := routeAttachmentTraceItems(files, nativeInputs{Policy: nativeInputPolicy{PDF: true}, Parts: map[string]llm.ContentPart{"report": {}}}, false)
	summary, markdown, payload := buildAttachmentProcessTrace("auto", first)
	recorder.appendProcessSection(summary, markdown, payload, messageTraceStatusStreaming)
	recorder.appendProcessSection("检索完成", "**内容检索**：完成。", nil, messageTraceStatusStreaming)

	nextSummary, nextMarkdown, nextPayload := buildAttachmentProcessTrace("auto", routeAttachmentTraceItems(files, nativeInputs{Policy: nativeInputPolicy{}}, false))
	recorder.replaceProcessSection(summary, markdown, nextSummary, nextMarkdown, nextPayload)

	if refs := recorder.process.payload.FileGroupRefs; len(refs.Native) != 0 || len(refs.Adaptive) != 1 {
		t.Fatalf("expected file groups of the failover route, got %#v", refs)
	}
	if strings.Count(recorder.process.contentMarkdown, "**文件上下文**") != 1 || !strings.Contains(recorder.process.contentMarkdown, "**内容检索**") {
		t.Fatalf("expected the file context section replaced in place, got %q", recorder.process.contentMarkdown)
	}
	if recorder.process.summary != "检索完成" {
		t.Fatalf("a later stage title must be kept, got %q", recorder.process.summary)
	}
	fileStages := 0
	for _, stage := range recorder.process.payload.Stages {
		if stage.Kind == processTraceKindFileContext {
			fileStages++
		}
	}
	if fileStages != 1 {
		t.Fatalf("expected a single file context stage, got %#v", recorder.process.payload.Stages)
	}
}

func nativeMedia(fileID string, mime string, size int64) AttachmentInput {
	category := fileCategoryAudio
	if strings.HasPrefix(mime, "video/") {
		category = fileCategoryVideo
	}
	return AttachmentInput{
		FileID: fileID, FileName: fileID, FileCategory: category, MimeType: mime, DetectedMIME: mime,
		StoragePath: "files/" + fileID, FileSize: size, ContextMode: fileContextModeSkipped, Current: true, MessageRole: "user",
	}
}

// 音视频仅按协议与 MIME 编码能力判断，不因模型声明或中转地址丢弃。
func TestResolveNativeInputPolicyForAudioAndVideo(t *testing.T) {
	all := []string{"text", "image", "pdf", "audio", "video"}
	mp3 := nativeMedia("voice.mp3", "audio/mpeg", 1024)
	m4a := nativeMedia("voice.m4a", "audio/mp4", 1024)
	mov := nativeMedia("clip.mov", "video/quicktime", 1024)
	for _, test := range []struct {
		name  string
		route channel.ResolvedRoute
		want  map[string]bool
	}{
		{name: "gemini", route: channel.ResolvedRoute{Protocol: llm.AdapterGoogleGenerateContent, BaseURL: "https://relay.example.com", CatalogInputModalities: all},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": false, "clip.mov": true}},
		{name: "official openai chat", route: channel.ResolvedRoute{Protocol: llm.AdapterOpenAIChatCompletions, BaseURL: "https://api.openai.com/v1", CatalogInputModalities: all},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": false, "clip.mov": false}},
		{name: "openai responses has no audio input", route: channel.ResolvedRoute{Protocol: llm.AdapterOpenAIResponses, BaseURL: "https://api.openai.com/v1", CatalogInputModalities: all},
			want: map[string]bool{"voice.mp3": false, "voice.m4a": false, "clip.mov": false}},
		{name: "official openrouter chat", route: channel.ResolvedRoute{Protocol: llm.AdapterOpenRouterChat, BaseURL: "https://openrouter.ai/api/v1", CatalogInputModalities: all},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": true, "clip.mov": true}},
		{name: "relay without declaration", route: channel.ResolvedRoute{Protocol: llm.AdapterOpenRouterChat, BaseURL: "https://relay.example.com/v1", CatalogInputModalities: all},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": true, "clip.mov": true}},
		{name: "relay with declaration", route: channel.ResolvedRoute{Protocol: llm.AdapterOpenAIChatCompletions, BaseURL: "https://relay.example.com/v1", ModelCapabilitiesJSON: `{"inputModalities":["audio"]}`},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": false, "clip.mov": false}},
		{name: "model without audio", route: channel.ResolvedRoute{Protocol: llm.AdapterGoogleGenerateContent, CatalogInputModalities: []string{"text", "video"}},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": false, "clip.mov": true}},
		{name: "explicit text", route: channel.ResolvedRoute{Protocol: llm.AdapterGoogleGenerateContent, ModelCapabilitiesJSON: `{"inputModalities":["text"]}`},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": false, "clip.mov": true}},
		{name: "unknown", route: channel.ResolvedRoute{Protocol: llm.AdapterGoogleGenerateContent},
			want: map[string]bool{"voice.mp3": true, "voice.m4a": false, "clip.mov": true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			route := test.route
			policy := resolveNativeInputPolicy(&route)
			for _, att := range []AttachmentInput{mp3, m4a, mov} {
				if got := policy.accepts(att); got != test.want[att.FileID] {
					t.Fatalf("%s accepted = %v, want %v", att.FileID, got, test.want[att.FileID])
				}
			}
		})
	}
}

// 音视频与 PDF 共用总预算；助手生成的视频不回传。
func TestSelectNativeInputsSharesBudgetWithMedia(t *testing.T) {
	policy := nativeInputPolicy{PDF: true, AudioMIMEs: geminiNativeAudioMIMEs, VideoMIMEs: geminiNativeVideoMIMEs}
	generated := nativeMedia("generated.mp4", "video/mp4", 1024)
	generated.Current, generated.MessageRole = false, "assistant"
	attachments := []AttachmentInput{
		nativeMedia("old.mp4", "video/mp4", 6*1024*1024),
		generated,
		nativePDF("report", 4*1024*1024, 10, false),
		nativeMedia("voice.mp3", "audio/mpeg", 5*1024*1024),
	}
	ids := make([]string, 0)
	for _, att := range selectNativeInputs(attachments, policy) {
		ids = append(ids, att.FileID)
	}
	// voice(5MB)+report(4MB) 后只剩 5MB，old.mp4(6MB) 超出总预算。
	if got := strings.Join(ids, ","); got != "voice.mp3,report" {
		t.Fatalf("selected = %q", got)
	}
}

// 端到端：Gemini 路由原生发送音频；不支持音频的路由在所属轮次留「不支持」说明，不发送内容块。
func TestBuildMessageRoutePromptSendsNativeAudioPerRoute(t *testing.T) {
	store := objectstorage.NewLocal(t.TempDir())
	if _, err := store.Put(t.Context(), "files/voice.mp3", bytes.NewReader([]byte("ID3 audio")), objectstorage.PutOptions{ContentType: "audio/mpeg"}); err != nil {
		t.Fatalf("put audio: %v", err)
	}
	service := &Service{storeProvider: &nativeInputTestStoreProvider{store: store}}
	voice := nativeMedia("voice.mp3", "audio/mpeg", int64(len("ID3 audio")))
	input := messageRoutePromptInput{
		DomainMessages:    []model.Message{{Role: "user", Content: "转写这段录音"}},
		ConversationFiles: []AttachmentInput{voice},
	}

	native, err := service.buildMessageRoutePrompt(t.Context(), &channel.ResolvedRoute{
		Protocol: llm.AdapterGoogleGenerateContent, CatalogInputModalities: []string{"text", "audio"},
	}, input)
	if err != nil {
		t.Fatalf("build native prompt: %v", err)
	}
	parts := native.Messages[len(native.Messages)-1].Parts
	if len(parts) != 3 || parts[1].Kind != llm.ContentPartAudio || parts[1].MimeType != "audio/mp3" || string(parts[1].Data) != "ID3 audio" {
		t.Fatalf("expected file note, native audio, then question, got %#v", parts)
	}
	if !strings.Contains(parts[0].Text, `<document source="voice.mp3" access="native">`) {
		t.Fatalf("expected a native note, got %q", parts[0].Text)
	}

	textOnly, err := service.buildMessageRoutePrompt(t.Context(), &channel.ResolvedRoute{
		Protocol: llm.AdapterAnthropicMessages, CatalogInputModalities: []string{"text", "audio"},
	}, input)
	if err != nil {
		t.Fatalf("build fallback prompt: %v", err)
	}
	latest := textOnly.Messages[len(textOnly.Messages)-1]
	for _, part := range latest.Parts {
		if part.Kind == llm.ContentPartAudio {
			t.Fatalf("routes without audio input must not receive audio, got %#v", part)
		}
	}
	if documents, _ := turnParts(t, latest); !strings.Contains(documents, `<document source="voice.mp3" access="unsupported">`) {
		t.Fatalf("expected an unsupported note, got %q", documents)
	}
}
