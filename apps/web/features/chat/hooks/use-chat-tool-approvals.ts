"use client";

import * as React from "react";
import { decideToolApproval, listToolApprovals, type ToolApproval } from "@/shared/api/tool-approvals";
import { useAuthSession } from "@/shared/auth/auth-session-context";

export function useChatToolApprovals(conversationID: string | undefined) {
  const { accessToken } = useAuthSession();
  const [state, setState] = React.useState<{ token: string; conversationID: string; items: ToolApproval[]; failed: boolean } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const refreshRef = React.useRef<() => void>(() => undefined);

  React.useEffect(() => {
    if (!accessToken || !conversationID) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (disposed || document.visibilityState !== "visible" || controller) return;
      clearTimeout(timer);
      controller = new AbortController();
      try {
        const pending = await listToolApprovals(accessToken, controller.signal);
        if (!disposed && !controller.signal.aborted) {
          setState({ token: accessToken, conversationID, items: (pending ?? []).filter((item) => item.conversation_public_id === conversationID && item.mode === "manual" && item.status === "pending" && Date.parse(item.expires_at) > Date.now()), failed: false });
        }
      } catch {
        if (!disposed && !controller.signal.aborted) {
          setState((current) => ({ token: accessToken, conversationID, items: current?.token === accessToken && current.conversationID === conversationID ? current.items : [], failed: true }));
        }
      } finally {
        controller = null;
        if (!disposed && document.visibilityState === "visible") timer = setTimeout(() => { void poll(); }, 2000);
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
      else controller?.abort();
    };
    refreshRef.current = () => { void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      refreshRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [accessToken, conversationID]);

  const current = state?.token === accessToken && state?.conversationID === conversationID;
  const failed = Boolean(current && state?.failed);
  const items = current ? state?.items ?? [] : [];
  const decide = async (item: ToolApproval, decision: "allow" | "deny") => {
    if (busy || failed || !accessToken || !conversationID || item.conversation_public_id !== conversationID || !items.some((entry) => entry.id === item.id) || document.visibilityState !== "visible") return;
    if (Date.parse(item.expires_at) <= Date.now()) {
      refreshRef.current();
      throw new Error("expired");
    }
    setBusy(item.id);
    try {
      await decideToolApproval(accessToken, item.id, decision);
      setState((current) => current?.token === accessToken && current.conversationID === conversationID ? { ...current, items: current.items.filter((entry) => entry.id !== item.id) } : current);
    } finally {
      setBusy(null);
      refreshRef.current();
    }
  };
  return { items, busy, failed, decide };
}
