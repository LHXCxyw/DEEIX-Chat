// 对话与画布共用的流式请求偏好：默认开启，关闭后后端改用非流式请求上游。
const STREAM_PREFERENCE_KEY = "deeix:chat:stream-enabled";

export function readChatStreamEnabled(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(STREAM_PREFERENCE_KEY);
    return raw === null ? true : raw !== "false";
  } catch {
    return true;
  }
}

export function writeChatStreamEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STREAM_PREFERENCE_KEY, enabled ? "true" : "false");
  } catch {
    // 存储不可用时只影响下次记忆，不影响本次请求。
  }
}
