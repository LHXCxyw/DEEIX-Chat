export {
  ChatSessionProvider,
  useChatSession,
  useConversationRunning,
} from "@/features/chat/context/chat-session-context";

// The exports below are the read-only message rendering contract consumed by share (the public share page).
// Internal refactors must not break these symbols' semantics; new cross-feature consumers must go through this entry point, never deep internal paths.
export { ChatMessageBot } from "@/features/chat/components/message/message-bot";
export { ChatMessageUser } from "@/features/chat/components/message/message-user";
export {
  buildChildrenIndex,
  buildVisibleMessages,
  mapServerMessage,
  reconcileBranchSelections,
  toBranchKey,
} from "@/features/chat/model/chat-thread";
export type { ChatAreaMessage } from "@/features/chat/types/messages";
export { ChatArtifactWorkspace } from "@/features/chat/components/sections/chat-artifact";
export { useChatArtifactResize } from "@/features/chat/hooks/use-chat-artifact-resize";
export { useChatArtifacts } from "@/features/chat/hooks/use-chat-artifacts";
export type { OpenCodeArtifactInput } from "@/features/chat/model/chat-artifacts";
export { AppChatArea } from "@/features/chat/components/app-chat-area";
export { AssistantImageGenerationSkeleton } from "@/features/chat/components/message/message-bot";

// 创作画布复用对话侧的模型目录/参数布局/消息附件解析：经此公共入口供跨功能消费。
export { parseAttachments } from "@/features/chat/model/chat-thread";
export type { ChatModelOption, ModelOptionControl } from "@/features/chat/types/chat-runtime";
export { useChatModelOptions } from "@/features/chat/hooks/use-chat-model-options";
export {
  resolveDesktopMenuListMaxHeight,
  resolveDesktopModelMenuListMaxHeight,
} from "@/features/chat/components/sections/chat-model-picker-layout";
