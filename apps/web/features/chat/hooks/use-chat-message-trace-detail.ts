"use client";

import * as React from "react";
import { mapProcessTrace } from "@/features/chat/model/chat-thread";
import { readMessageTraceDetail, readMessageTraceDetailVersion, subscribeMessageTraceDetails, writeMessageTraceDetail } from "@/features/chat/model/message-trace-detail-store";
import { parseRecord } from "@/features/chat/model/project-file-changes";
import type { ChatAreaMessage, ChatMessageProcessTrace } from "@/features/chat/types/messages";
import { getMessageProcessTrace } from "@/shared/api/conversation";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { readSessionRevision } from "@/shared/auth/session";

export function hasWorkspaceChangeSummary(trace: ChatMessageProcessTrace | undefined): boolean {
  const names = new Set(["project_write_file", "project_patch_file", "project_delete_file", "project_create_archive"]);
  return [trace?.tools, ...(trace?.events ?? [])].some((source) => {
    const payload = parseRecord(source?.payloadJson);
    return Array.isArray(payload?.tool_calls) && payload.tool_calls.some((raw) => {
      const call = parseRecord(raw);
      return typeof call?.name === "string" && names.has(call.name);
    });
  });
}

export function canLoadMessageTrace(message: ChatAreaMessage): boolean {
  return message.role === "assistant" && Boolean(message.publicID && (message.serverMessageID ?? 0) > 0) && !message.isStreaming && !message.isPending && message.status !== "pending";
}

export function useChatMessageTraceDetail(messagePublicID: string | undefined, trace: ChatMessageProcessTrace | undefined) {
  const key = messagePublicID?.trim() ?? "";
  const omitted = Boolean(key && trace?.detailOmitted);
  const detail = React.useSyncExternalStore(
    subscribeMessageTraceDetails,
    () => omitted ? readMessageTraceDetail(key) : undefined,
    (): undefined => undefined,
  );
  const loadDetail = React.useCallback(() => {
    const status = readMessageTraceDetail(key)?.status;
    if (!omitted || status === "loading" || status === "loaded") return;
    const revision = readSessionRevision();
    writeMessageTraceDetail(key, { status: "loading" }, revision);
    void (async () => {
      try {
        const token = await resolveAccessToken();
        if (revision !== readSessionRevision()) return;
        if (!token) throw new Error("未登录");
        const full = mapProcessTrace(await getMessageProcessTrace(token, key));
        if (!full || full.detailOmitted) throw new Error("轨迹详情不可用");
        writeMessageTraceDetail(key, { status: "loaded", trace: full }, revision);
      } catch {
        writeMessageTraceDetail(key, { status: "failed" }, revision);
      }
    })();
  }, [key, omitted]);
  return {
    trace: omitted && detail?.status === "loaded" ? detail.trace : trace,
    detailPending: omitted && detail?.status !== "loaded",
    detailFailed: omitted && detail?.status === "failed",
    loadDetail,
  };
}

// 同步工作区侧栏和累计 Diff 的数据源，不修改消息状态或覆盖实时流。
export function useChatMessagesWithTraceDetails(messages: ChatAreaMessage[]): ChatAreaMessage[] {
  const version = React.useSyncExternalStore(subscribeMessageTraceDetails, readMessageTraceDetailVersion, () => 0);
  return React.useMemo(() => {
    void version;
    return messages.map((message) => {
      if (!canLoadMessageTrace(message) || !message.processTrace?.detailOmitted) return message;
      const detail = readMessageTraceDetail(message.publicID);
      return detail?.status === "loaded" ? { ...message, processTrace: detail.trace } : message;
    });
  }, [messages, version]);
}
