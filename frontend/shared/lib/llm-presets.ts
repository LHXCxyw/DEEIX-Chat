/** 上游兼容协议预设，管理端与用户自有渠道共用 */
export const COMPATIBLE_PRESETS = [
  { label: "OpenAI", value: "openai" },
  { label: "Anthropic", value: "anthropic" },
  { label: "Google", value: "google" },
  { label: "xAI", value: "xai" },
  { label: "OpenRouter", value: "openrouter" },
  { label: "Custom", value: "custom" },
] as const;

export type LLMProtocolPreset = {
  value: string;
  label: string;
  kinds: readonly string[];
};

/** 模型调用协议预设，value 与后端适配器标识一致 */
export const PROTOCOL_PRESETS: ReadonlyArray<LLMProtocolPreset> = [
  { value: "openai_responses", label: "Responses (OpenAI)", kinds: ["chat"] },
  { value: "openai_chat_completions", label: "Chat Completions (OpenAI)", kinds: ["chat"] },
  { value: "openai_image_generations", label: "Images Generations (OpenAI)", kinds: ["image_gen"] },
  { value: "openai_image_edits", label: "Images Edits (OpenAI)", kinds: ["image_edit"] },
  { value: "openai_video_generations", label: "Video Generations (OpenAI)", kinds: ["video_gen"] },
  { value: "anthropic_messages", label: "Messages (Anthropic)", kinds: ["chat"] },
  { value: "google_generate_content", label: "Generate Content (Google)", kinds: ["chat"] },
  { value: "google_image_generation", label: "Image Generation (Google)", kinds: ["image_gen", "image_edit"] },
  { value: "gemini_interactions", label: "Interactions (Google)", kinds: ["chat", "image_gen", "image_edit", "video_gen"] },
  { value: "xai_responses", label: "Responses (xAI)", kinds: ["chat"] },
  { value: "xai_image", label: "Images Generations (xAI)", kinds: ["image_gen"] },
  { value: "xai_image_edits", label: "Images Edits (xAI)", kinds: ["image_edit"] },
  { value: "xai_video", label: "Video Generations (xAI)", kinds: ["video_gen"] },
  { value: "xai_video_extensions", label: "Video Extensions (xAI)", kinds: ["video_extension"] },
  { value: "openrouter_chat_completions", label: "Chat Completions (OpenRouter)", kinds: ["chat"] },
  { value: "openrouter_responses", label: "Responses (OpenRouter)", kinds: ["chat"] },
] as const;

/** 按兼容协议推荐默认的聊天调用协议 */
export const DEFAULT_PROTOCOL_BY_COMPATIBLE: Record<string, string> = {
  openai: "openai_chat_completions",
  anthropic: "anthropic_messages",
  google: "google_generate_content",
  xai: "xai_responses",
  openrouter: "openrouter_chat_completions",
  custom: "openai_chat_completions",
};

/** 根据协议推导模型能力类型 JSON，用于用户模型的 kinds 字段 */
export function resolveProtocolKindsJSON(protocol: string): string {
  const preset = PROTOCOL_PRESETS.find((item) => item.value === protocol);
  return JSON.stringify(preset ? [...preset.kinds] : ["chat"]);
}
