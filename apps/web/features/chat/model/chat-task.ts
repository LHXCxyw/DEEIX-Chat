import type { ChatModelOption, PendingAttachment } from "@/features/chat/types/chat-runtime";
import type { ConversationOptions } from "@/shared/api/conversation-types";
import { isRecord } from "@/shared/lib/type-guards";

export type ChatSubmitTask = "chat" | "image_generation" | "image_edit" | "video_generation" | "video_extension";
export type ChatSubmitBlockReason =
  | "image_edit_input_required"
  | "image_edit_unsupported"
  | "image_generation_rejects_attachments"
  | "image_task_rejects_non_image_attachments"
  | "video_generation_unsupported_audio"
  | "video_task_rejects_non_image_attachments"
  | "video_extension_requires_single_mp4"
  | "video_extension_unsupported"
  | "model_task_unsupported";

// 视频生成参考素材不设平台侧数量上限，交由上游校验；这里只判断协议是否接受参考音频。
function videoProtocolSupportsAudio(model: ChatModelOption | null): boolean {
  return (model?.protocols ?? []).some((item) => item.trim().toLowerCase() === "openai_video_generations");
}

export type ChatSubmitDecision = {
  task: ChatSubmitTask;
  blockedReason: ChatSubmitBlockReason | null;
  attachmentCount: number;
  imageAttachmentCount: number;
  nonImageAttachmentCount: number;
  supportsChat: boolean;
  supportsImageGeneration: boolean;
  supportsImageEdit: boolean;
  supportsVideoGeneration: boolean;
  supportsVideoExtension: boolean;
};

function isImageAttachment(item: PendingAttachment): boolean {
  return item.fileCategory === "image" || item.mimeType.toLowerCase().startsWith("image/");
}

function isMP4Attachment(item: PendingAttachment): boolean {
  return item.mimeType.toLowerCase() === "video/mp4" || item.detectedMime?.toLowerCase() === "video/mp4";
}

function isVideoAttachment(item: PendingAttachment): boolean {
  return item.mimeType.toLowerCase().startsWith("video/") || item.detectedMime?.toLowerCase().startsWith("video/") === true;
}

function isAudioAttachment(item: PendingAttachment): boolean {
  return item.mimeType.toLowerCase().startsWith("audio/") || item.detectedMime?.toLowerCase().startsWith("audio/") === true;
}

function buildDecision(
  task: ChatSubmitTask,
  blockedReason: ChatSubmitBlockReason | null,
  input: Omit<ChatSubmitDecision, "task" | "blockedReason">,
): ChatSubmitDecision {
  return {
    task,
    blockedReason,
    ...input,
  };
}

function optionObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function responseFormatType(value: unknown): "image" | "video" | "text" | "" {
  if (Array.isArray(value)) {
    if (value.some((item) => responseFormatType(item) === "video")) return "video";
    if (value.some((item) => responseFormatType(item) === "image")) return "image";
    if (value.some((item) => responseFormatType(item) === "text")) return "text";
    return "";
  }
  const format = optionObject(value);
  const type = typeof format?.type === "string" ? format.type.trim().toLowerCase() : "";
  if (type === "image" || type === "video" || type === "text") {
    return type;
  }
  return "";
}

function requestedResponseType(options?: ConversationOptions): "image" | "video" | "text" | "" {
  if (!options) {
    return "";
  }
  return responseFormatType(options.response_format);
}

export function resolveChatSubmitDecision(
  model: ChatModelOption | null,
  attachments: PendingAttachment[],
  options?: ConversationOptions,
): ChatSubmitDecision {
  const kinds = new Set(model?.kinds ?? []);
  const attachmentCount = attachments.length;
  const imageAttachmentCount = attachments.filter(isImageAttachment).length;
  const mp4AttachmentCount = attachments.filter(isMP4Attachment).length;
  const videoAttachmentCount = attachments.filter(isVideoAttachment).length;
  const audioAttachmentCount = attachments.filter(isAudioAttachment).length;
  const nonImageAttachmentCount = attachmentCount - imageAttachmentCount;
  // 视频生成不支持的其余类型（文档、压缩包等）。
  const unsupportedAttachmentCount = attachmentCount - imageAttachmentCount - videoAttachmentCount - audioAttachmentCount;
  const supportsChat = kinds.size === 0 || kinds.has("chat") || kinds.has("audio");
  const supportsImageGeneration = kinds.has("image_gen");
  const supportsImageEdit = kinds.has("image_edit");
  const supportsVideoGeneration = kinds.has("video_gen");
  const supportsVideoExtension = model?.videoExtension?.enabled === true;
  const baseDecision = {
    attachmentCount,
    imageAttachmentCount,
    nonImageAttachmentCount,
    supportsChat,
    supportsImageGeneration,
    supportsImageEdit,
    supportsVideoGeneration,
    supportsVideoExtension,
  };
  const requestedType = requestedResponseType(options);

  // Video attachments extend the video on models that declare video extension; a generation-only video
  // model instead receives them as reference material (extra_videos).
  if (videoAttachmentCount > 0 && supportsVideoExtension) {
    if (attachmentCount !== 1 || mp4AttachmentCount !== 1) {
      return buildDecision("video_extension", "video_extension_requires_single_mp4", baseDecision);
    }
    return buildDecision("video_extension", null, baseDecision);
  }

  // 视频生成支持多模态参考素材：参考图、参考视频、参考音频可混合上传。
  if (supportsVideoGeneration && (imageAttachmentCount > 0 || videoAttachmentCount > 0 || audioAttachmentCount > 0)) {
    if (unsupportedAttachmentCount > 0) {
      return buildDecision("video_generation", "video_task_rejects_non_image_attachments", baseDecision);
    }
    // 参考音频并非所有视频协议都接受：不支持的协议直接说明，避免发送后才由上游报错。
    if (audioAttachmentCount > 0 && !videoProtocolSupportsAudio(model)) {
      return buildDecision("video_generation", "video_generation_unsupported_audio", baseDecision);
    }
    return buildDecision("video_generation", null, baseDecision);
  }

  if (
    nonImageAttachmentCount > 0 &&
    (supportsImageGeneration || supportsImageEdit || supportsVideoGeneration) &&
    (imageAttachmentCount > 0 || !supportsChat)
  ) {
    if (imageAttachmentCount > 0 && supportsImageEdit) {
      return buildDecision("image_edit", "image_task_rejects_non_image_attachments", baseDecision);
    }
    if (supportsVideoGeneration) {
      return buildDecision("video_generation", "video_task_rejects_non_image_attachments", baseDecision);
    }
    if (supportsImageGeneration) {
      return buildDecision("image_generation", "image_task_rejects_non_image_attachments", baseDecision);
    }
    return buildDecision("chat", "image_task_rejects_non_image_attachments", baseDecision);
  }

  if (imageAttachmentCount > 0) {
    if (supportsImageEdit) {
      return buildDecision("image_edit", null, baseDecision);
    }
    if (supportsChat) {
      return buildDecision("chat", null, baseDecision);
    }
    return buildDecision("chat", "image_edit_unsupported", baseDecision);
  }

  if (attachmentCount > 0) {
    if (supportsChat) {
      return buildDecision("chat", null, baseDecision);
    }
    if (supportsImageGeneration) {
      return buildDecision("image_generation", "image_generation_rejects_attachments", baseDecision);
    }
    if (supportsVideoGeneration) {
      return buildDecision("video_generation", "video_task_rejects_non_image_attachments", baseDecision);
    }
    return buildDecision("chat", "model_task_unsupported", baseDecision);
  }

  if (requestedType === "video" && supportsVideoGeneration) {
    return buildDecision("video_generation", null, baseDecision);
  }
  if (requestedType === "image" && supportsImageGeneration) {
    return buildDecision("image_generation", null, baseDecision);
  }
  if (supportsChat) {
    return buildDecision("chat", null, baseDecision);
  }
  if (supportsImageGeneration) {
    return buildDecision("image_generation", null, baseDecision);
  }
  if (supportsVideoGeneration) {
    return buildDecision("video_generation", null, baseDecision);
  }
  if (supportsImageEdit && !supportsChat) {
    return buildDecision("image_edit", "image_edit_input_required", baseDecision);
  }
  if (!supportsChat) {
    return buildDecision("chat", "model_task_unsupported", baseDecision);
  }

  return buildDecision("chat", null, baseDecision);
}

export function isMediaSubmitTask(task: ChatSubmitTask): boolean {
  return task === "image_generation" || task === "image_edit" || task === "video_generation" || task === "video_extension";
}
