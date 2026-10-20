package conversation

import (
	"context"
	"fmt"
	"time"
)

type AgentCapability struct {
	Configured bool   `json:"configured"`
	Ready      bool   `json:"ready"`
	Code       string `json:"code"`
	Reason     string `json:"reason"`
}

type AgentCapabilities struct {
	File              AgentCapability `json:"file"`
	Command           AgentCapability `json:"command"`
	Browser           AgentCapability `json:"browser"`
	ProjectBrowser    AgentCapability `json:"project_browser"`
	OfflineScreenshot AgentCapability `json:"offline_screenshot"`
}

func unavailableBrowserCapability() AgentCapability {
	return AgentCapability{Code: "browser_execution_not_deployed", Reason: "公网浏览器执行未部署：未接入经过验证的独立出站隔离；不能公网浏览或交互。独立的离线单 HTML 截图能力见 offline_screenshot。"}
}

type executionNodeDescriber interface {
	ExecutionNode() string
}

// executionNodeName 只描述执行节点来源，不暴露端点地址、证书路径或凭据。
func executionNodeName(executor any) string {
	if describer, ok := executor.(executionNodeDescriber); ok && describer.ExecutionNode() == "remote" {
		return "远程 Docker 执行节点"
	}
	return "本地 Docker 执行节点"
}

// AgentCapabilities 描述服务器执行环境，不代表当前用户授权或本轮模型工具可用性。
func (s *Service) AgentCapabilities(ctx context.Context) AgentCapabilities {
	result := AgentCapabilities{
		File:              AgentCapability{Code: "file_dependencies_unavailable", Reason: "文件仓库或存储提供器未接入。"},
		Command:           AgentCapability{Code: "command_not_configured", Reason: "管理员未启用隔离命令执行器；完全访问授权不会自动部署。"},
		Browser:           unavailableBrowserCapability(),
		ProjectBrowser:    s.projectBrowserCapability(ctx),
		OfflineScreenshot: s.offlineScreenshotCapability(ctx),
	}
	if s.repo != nil && s.storeProvider != nil {
		result.File = AgentCapability{Configured: true, Code: "file_storage_unavailable", Reason: "文件存储当前不可用。"}
		if _, err := s.storeProvider.Open(ctx); err == nil {
			result.File = AgentCapability{Configured: true, Ready: true, Code: "ready", Reason: "工作区文件工具及存储已接入；具体读写仍受工作区和本轮授权约束。"}
		}
	}
	r := s.agentRuntime
	if r == nil {
		return result
	}
	node := executionNodeName(r.executor)
	result.Command = AgentCapability{Configured: true, Code: "command_readiness_unverified", Reason: fmt.Sprintf("命令执行器已配置（执行节点：%s），但不提供运行环境就绪检查，不能宣称可执行。", node)}
	checker, ok := r.executor.(interface {
		CheckReadiness(context.Context, string) error
	})
	if !ok {
		return result
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := checker.CheckReadiness(probeCtx, r.image); err != nil {
		result.Command.Code = "command_runtime_unavailable"
		result.Command.Reason = fmt.Sprintf("隔离命令运行环境未就绪（执行节点：%s）：Docker 不可达、资源隔离不受支持或管理员指定的镜像不可用；不会回退到宿主机执行。", node)
		return result
	}
	result.Command = AgentCapability{Configured: true, Ready: true, Code: "ready", Reason: fmt.Sprintf("隔离守护进程及镜像检查通过（执行节点：%s）；执行时仍重新校验隔离、审批及资源准入，仅支持断网临时命令，不提供浏览器截图。", node)}
	return result
}

func (s *Service) offlineScreenshotCapability(ctx context.Context) AgentCapability {
	result := AgentCapability{Code: "offline_screenshot_disabled", Reason: "管理员未启用独立离线截图运行时。"}
	r := s.screenshotRuntime
	if r == nil {
		return result
	}
	node := executionNodeName(r.executor)
	result.Configured = true
	result.Code = "offline_screenshot_unavailable"
	result.Reason = fmt.Sprintf("离线截图依赖或镜像未就绪（执行节点：%s）；不会回退宿主浏览器。", node)
	if s.repo == nil || s.storeProvider == nil || s.uploadSvc == nil {
		return result
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := s.storeProvider.Open(probe); err != nil {
		return result
	}
	checker, ok := r.executor.(interface {
		CheckReadiness(context.Context, string) error
	})
	if !ok || checker.CheckReadiness(probe, r.image) != nil {
		return result
	}
	result.Ready = true
	result.Code = "offline_static_image_ready"
	result.Reason = fmt.Sprintf("离线截图镜像及隔离元数据检查通过（执行节点：%s）；每次执行仍必须通过 Chromium sandbox 自检。不支持 JS、外链或页面交互，不代表完整页面验证。", node)
	return result
}

func (s *Service) projectBrowserCapability(ctx context.Context) AgentCapability {
	result := AgentCapability{Code: "project_browser_disabled", Reason: "管理员未启用独立断网项目浏览器；公网浏览未开放。"}
	r := s.projectBrowserRuntime
	if r == nil {
		return result
	}
	node := executionNodeName(r.executor)
	result.Configured = true
	result.Code = "project_browser_unavailable"
	result.Reason = fmt.Sprintf("项目浏览器依赖或交互镜像身份未就绪（执行节点：%s），不回退到静态 renderer 或宿主浏览器。", node)
	if s.repo == nil || s.storeProvider == nil || s.uploadSvc == nil {
		return result
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := s.storeProvider.Open(probe); err != nil {
		return result
	}
	checker, ok := r.executor.(interface {
		CheckReadiness(context.Context, string) error
	})
	if !ok || checker.CheckReadiness(probe, r.image) != nil {
		return result
	}
	result.Ready = true
	result.Code = "project_browser_metadata_ready"
	result.Reason = fmt.Sprintf("独立交互镜像及隔离元数据检查通过（执行节点：%s）；执行仍需 sandbox 自检、宿主 network none inspect、审批及容量准入。仅运行可信工作区多文件快照，无公网浏览或持久页面。", node)
	return result
}

func (s *Service) agentCapabilityPrompt(runtime selectedToolRuntime) string {
	command := "本轮未注册 workspace_run_command，不能执行命令。"
	screenshot := "本轮未注册 project_render_screenshot，不能生成离线静态截图。"
	projectBrowser := "本轮未注册 project_browser_run，不能运行项目交互浏览器。"
	for _, tool := range runtime.definitions {
		if tool.Name == "project_browser_run" {
			projectBrowser = "本轮注册 project_browser_run：一次性多文件快照交互仅限断网 sandbox；DOM/console 不可信，只有真实成功结果可作为执行证据，公网浏览未开放。"
		}
		if tool.Name == "project_render_screenshot" {
			screenshot = "本轮注册了 project_render_screenshot；仅限工作区单 HTML 离线静态截图，禁 JS/外链，不是交互验证；仅成功附件结果可作为截图证据。"
		}
	}
	for _, tool := range runtime.definitions {
		if tool.Name == "workspace_run_command" {
			command = "本轮注册了 workspace_run_command，但配置不等于运行就绪；仅在真实工具调用成功后报告验证结果，失败时如实说明，不得回退宿主机。"
			break
		}
	}
	return fmt.Sprintf("[服务器执行能力边界]\n授权不等于部署，完全访问不会创建执行器；只可调用本轮实际提供的工具。\n%s\n%s\n%s\n项目 iframe 预览不是 Agent 浏览器，不能假称已浏览、运行页面或获得截图；必须有真实工具结果才能报告完成。", unavailableBrowserCapability().Reason, command, screenshot+"\n"+projectBrowser)
}
