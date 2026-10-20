import { authedRequest } from "@/shared/api/authed-client";

export type AgentCapability = {
  configured: boolean;
  ready: boolean;
  code: string;
  reason: string;
};

export type AgentCapabilities = {
  file: AgentCapability;
  command: AgentCapability;
  browser: AgentCapability;
  project_browser: AgentCapability;
  offline_screenshot: AgentCapability;
};

export function getAgentCapabilities(accessToken: string, signal?: AbortSignal) {
  return authedRequest<AgentCapabilities>("/api/v1/runtime/agent-capabilities", {
    accessToken,
    signal,
  });
}
