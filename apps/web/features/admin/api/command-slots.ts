import { authedRequest } from "@/shared/api/authed-client";
import { ApiError, ApiNetworkError, pathParam, resolveApiBaseURL, toApiError } from "@/shared/api/http-client";
import { authClient } from "@/shared/auth/auth-client";
import { isRecord } from "@/shared/lib/type-guards";

// 当前端点尚未进入生成契约；字段与后端 CommandSlotView 保持一致。
export type AdminCommandSlot = {
  slot: number;
  owner_user_id: number;
  operation_id: string;
  operation_status: string;
  operation_revision: number;
  lease_until: string;
  operation_lease_until?: string;
  snapshot: string;
  recovery: string;
  blocked_reason: string;
};

export class CommandSlotRecoveryError extends ApiError {
  blockedReason: string;

  constructor(blockedReason: string) {
    super("Command slot recovery blocked", 409);
    this.blockedReason = blockedReason;
  }
}

export async function listAdminCommandSlots(accessToken: string, signal?: AbortSignal): Promise<AdminCommandSlot[]> {
  return authedRequest<AdminCommandSlot[]>("/api/v1/admin/agent-command-slots", { accessToken, signal });
}

export async function recoverAdminCommandSlot(accessToken: string, slot: AdminCommandSlot): Promise<void> {
  // blocked 的 409 响应不是标准 envelope，需要在统一鉴权策略内单独读取安全原因。
  return authClient.withAuthRetry({
    accessToken,
    allowRefresh: true,
    execute: async (token) => {
      let response: Response;
      try {
        response = await fetch(`${resolveApiBaseURL()}/api/v1/admin/agent-command-slots/${pathParam(slot.slot)}/recover`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_user_id: slot.owner_user_id,
            operation_id: slot.operation_id,
            operation_revision: slot.operation_revision,
            snapshot: slot.snapshot,
          }),
        });
      } catch (error) {
        throw new ApiNetworkError(error);
      }
      if (response.status === 409) {
        const payload: unknown = await response.clone().json().catch(() => null);
        if (isRecord(payload) && payload.status === "blocked" && payload.released === false) {
          const reason = isRecord(payload.slot) && typeof payload.slot.blocked_reason === "string"
            ? payload.slot.blocked_reason
            : "";
          throw new CommandSlotRecoveryError(reason);
        }
      }
      if (!response.ok) throw await toApiError(response);
    },
  });
}
