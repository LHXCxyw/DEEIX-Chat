package conversation

import (
	"context"
	"strings"
	"testing"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/channel"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

func TestAgentCapabilitiesFailClosed(t *testing.T) {
	s := &Service{}
	got := s.AgentCapabilities(context.Background())
	if got.File.Ready || got.Command.Ready || got.Browser.Ready || got.Browser.Configured {
		t.Fatalf("缺少执行依赖不应就绪: %+v", got)
	}
	if got.Browser.Code != "browser_execution_not_deployed" || !strings.Contains(got.Browser.Reason, "隔离") {
		t.Fatalf("缺少浏览器真实部署原因: %+v", got.Browser)
	}
	prompt := s.agentCapabilityPrompt(selectedToolRuntime{})
	if !strings.Contains(prompt, got.Browser.Reason) || !strings.Contains(prompt, "授权不等于部署") {
		t.Fatalf("模型提示未明确能力边界: %s", prompt)
	}
}

func TestAgentCapabilityBoundaryReachesModelPrompt(t *testing.T) {
	s := &Service{cfg: config.NewRuntime(config.Config{})}
	for _, protocol := range []string{llm.AdapterOpenAIChatCompletions, llm.AdapterGeminiInteractions} {
		plan, err := s.buildMessageRoutePrompt(t.Context(), &channel.ResolvedRoute{Protocol: protocol}, messageRoutePromptInput{UserContent: "请截图"})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, message := range plan.Messages {
			if strings.Contains(message.Content, unavailableBrowserCapability().Reason) && strings.Contains(message.Content, "授权不等于部署") {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s 模型输入缺少浏览器执行边界", protocol)
		}
	}
}
