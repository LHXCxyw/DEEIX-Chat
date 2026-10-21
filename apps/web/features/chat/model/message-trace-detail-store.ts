import type { ChatMessageProcessTrace } from "@/features/chat/types/messages";
import { readSessionRevision, SESSION_CLEARED_EVENT, SESSION_SNAPSHOT_CHANGED_EVENT } from "@/shared/auth/session";

export type MessageTraceDetail =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; trace: ChatMessageProcessTrace };

const details = new Map<string, MessageTraceDetail>();
const listeners = new Set<() => void>();
let revision = -1;
let version = 0;
let listening = false;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function readMessageTraceDetailVersion() {
  syncSession();
  return version;
}

function syncSession() {
  const next = readSessionRevision();
  if (next !== revision) {
    revision = next;
    details.clear();
  }
}

function sessionChanged() {
  syncSession();
  notify();
}

export function readMessageTraceDetail(messagePublicID: string): MessageTraceDetail | undefined {
  syncSession();
  return details.get(messagePublicID);
}

export function writeMessageTraceDetail(messagePublicID: string, detail: MessageTraceDetail, requestRevision: number) {
  syncSession();
  // 注销、换号或凭据刷新后，旧请求不能把敏感详情写回新会话。
  if (requestRevision !== revision) return;
  details.set(messagePublicID, detail);
  notify();
}

export function subscribeMessageTraceDetails(listener: () => void) {
  if (!listening && typeof window !== "undefined") {
    window.addEventListener(SESSION_SNAPSHOT_CHANGED_EVENT, sessionChanged);
    window.addEventListener(SESSION_CLEARED_EVENT, sessionChanged);
    listening = true;
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
