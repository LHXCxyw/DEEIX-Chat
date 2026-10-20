import { authedRequest } from "@/shared/api/authed-client";
import { pathParam } from "@/shared/api/http-client";

export type ToolApproval = {
  id: string;
  mode: string;
  conversation_id: number;
  conversation_public_id: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments_json: string;
  parameters_hash: string;
  workspace_version: string;
  status: string;
  expires_at: string;
  created_at: string;
};

export function listToolApprovals(accessToken: string, signal?: AbortSignal) {
  return authedRequest<ToolApproval[] | null>("/api/v1/tool-approvals", { accessToken, signal });
}

export function decideToolApproval(accessToken: string, id: string, decision: "allow" | "deny", signal?: AbortSignal) {
  return authedRequest<{ decision: "allow" | "deny" }>(`/api/v1/tool-approvals/${pathParam(id)}/decision`, {
    accessToken, method: "POST", body: { decision }, signal,
  });
}
