import type { ChatModelOption, ModelOptionControl } from "@/features/chat/types/chat-runtime";
import type { ConversationOptions } from "@/shared/api/conversation.types";

// 画布请求路由：media 图像生成 / media 图像编辑 / chat 路由图像模型
export type CanvasRoute = "image_generation" | "image_edit" | "chat";

export type CanvasRouteBlockReason =
  | "edit_reference_required"
  | "image_unsupported"
  | "edit_unsupported"
  | "chat_capability_required";

export type CanvasRouteDecision =
  | { route: CanvasRoute; blockedReason: null }
  | { route: null; blockedReason: CanvasRouteBlockReason };

const ASPECT_RATIO_VALUES = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const IMAGE_SIZE_VALUES = ["1K", "2K", "4K"];
const OPENAI_SIZE_VALUES = [
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
];
const XAI_ASPECT_RATIO_VALUES = [
  "auto",
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "2:3",
  "3:2",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
];

// 各图像协议对应的可视化参数控件，与普通对话的参数集合保持一致
const PROTOCOL_IMAGE_CONTROLS: Record<string, ModelOptionControl[]> = {
  openai_image_generations: [
    { path: "size", type: "select", options: OPENAI_SIZE_VALUES },
    { path: "quality", type: "select", options: ["auto", "low", "medium", "high", "standard", "hd"] },
    { path: "background", type: "select", options: ["auto", "opaque", "transparent"] },
    { path: "output_format", type: "select", options: ["png", "jpeg", "webp"] },
  ],
  openai_image_edits: [
    { path: "size", type: "select", options: OPENAI_SIZE_VALUES },
    { path: "quality", type: "select", options: ["auto", "low", "medium", "high", "standard", "hd"] },
    { path: "background", type: "select", options: ["auto", "opaque", "transparent"] },
    { path: "input_fidelity", type: "select", options: ["low", "high"] },
    { path: "output_format", type: "select", options: ["png", "jpeg", "webp"] },
  ],
  google_image_generation: [
    { path: "generationConfig.responseModalities", type: "select", options: ["TEXT", "IMAGE"] },
    { path: "generationConfig.imageConfig.aspectRatio", type: "select", options: ASPECT_RATIO_VALUES },
    { path: "generationConfig.imageConfig.imageSize", type: "select", options: IMAGE_SIZE_VALUES },
  ],
  google_generate_content: [
    { path: "generationConfig.imageConfig.aspectRatio", type: "select", options: ASPECT_RATIO_VALUES },
    { path: "generationConfig.imageConfig.imageSize", type: "select", options: IMAGE_SIZE_VALUES },
  ],
  gemini_generate_content: [
    { path: "generationConfig.imageConfig.aspectRatio", type: "select", options: ASPECT_RATIO_VALUES },
    { path: "generationConfig.imageConfig.imageSize", type: "select", options: IMAGE_SIZE_VALUES },
  ],
  gemini_interactions: [
    { path: "response_format.aspect_ratio", type: "select", options: ASPECT_RATIO_VALUES },
    { path: "response_format.image_size", type: "select", options: IMAGE_SIZE_VALUES },
    { path: "response_format.mime_type", type: "select", options: ["image/png", "image/jpeg", "image/webp"] },
  ],
  xai_image: [
    { path: "aspect_ratio", type: "select", options: XAI_ASPECT_RATIO_VALUES },
    { path: "n", type: "number" },
    { path: "resolution", type: "select", options: ["1k", "2k"] },
    { path: "response_format", type: "select", options: ["url", "b64_json"] },
  ],
  xai_image_edits: [
    { path: "aspect_ratio", type: "select", options: XAI_ASPECT_RATIO_VALUES },
    { path: "resolution", type: "select", options: ["1k", "2k"] },
    { path: "response_format", type: "select", options: ["url", "b64_json"] },
  ],
  stability_ai_generate: [
    { path: "aspect_ratio", type: "select", options: ASPECT_RATIO_VALUES },
    { path: "output_format", type: "select", options: ["png", "jpeg", "webp"] },
  ],
};

// chat 路由图像模型的通用提示词参数（与普通对话的画图参数一致）
const CHAT_ROUTE_IMAGE_CONTROLS: ModelOptionControl[] = [
  { path: "aspect_ratio", type: "select", options: ASPECT_RATIO_VALUES },
  { path: "image_size", type: "select", options: IMAGE_SIZE_VALUES },
];

const IMAGE_OPTION_PATHS = new Set([
  "aspect_ratio",
  "aspectRatio",
  "background",
  "generationConfig.imageConfig.aspectRatio",
  "generationConfig.imageConfig.imageSize",
  "generationConfig.mediaResolution",
  "generationConfig.responseMimeType",
  "generationConfig.responseModalities",
  "imageConfig.aspectRatio",
  "imageConfig.imageSize",
  "image_size",
  "imageSize",
  "input_fidelity",
  "moderation",
  "n",
  "output_compression",
  "output_format",
  "partial_images",
  "quality",
  "resolution",
  "response_format",
  "response_format.aspect_ratio",
  "response_format.image_size",
  "response_format.mime_type",
  "size",
]);

// 协议白名单与后端 IsRouteAllowedForTask 的 isProtocolAllowedForKind 保持一致。
// 不能用「协议名是否含 image」判断：gemini_interactions 是图像协议但名字无 image，
// 而 google_image_generation 同时属于 chat 允许集。
const IMAGE_GENERATION_PROTOCOLS = new Set([
  "openai_image_generations",
  "google_image_generation",
  "gemini_interactions",
  "xai_image",
]);

const IMAGE_EDIT_PROTOCOLS = new Set([
  "openai_image_edits",
  "google_image_generation",
  "gemini_interactions",
  "xai_image_edits",
]);

const CHAT_PROTOCOLS = new Set([
  "openai_responses",
  "openrouter_chat_completions",
  "openrouter_responses",
  "openai_chat_completions",
  "anthropic_messages",
  "google_generate_content",
  "gemini_interactions",
  "xai_responses",
]);

function modelHasProtocolIn(model: ChatModelOption | null, allowed: Set<string>): boolean {
  return Boolean(
    model?.protocols.some((protocol) => allowed.has(protocol.trim().toLowerCase())),
  );
}

// 模型是否具备任一图像协议（生成或编辑）
export function modelHasImageProtocol(model: ChatModelOption | null): boolean {
  return modelHasProtocolIn(model, IMAGE_GENERATION_PROTOCOLS)
    || modelHasProtocolIn(model, IMAGE_EDIT_PROTOCOLS);
}

// chat 路由图像模型：有图像能力但没有图像协议，只能走对话协议并用提示词后缀传参
export function isChatRouteImageModel(model: ChatModelOption | null): boolean {
  if (!model) {
    return false;
  }
  const supportsImage = model.kinds.includes("image_gen") || model.kinds.includes("image_edit");
  return supportsImage && !modelHasImageProtocol(model);
}

// 后端 chat 任务要求 kinds 含 chat 或 audio，且协议在 chat 允许集内；
// 空 kinds 时后端由协议单独判定。
function modelSupportsChatRoute(model: ChatModelOption): boolean {
  if (!modelHasProtocolIn(model, CHAT_PROTOCOLS)) {
    return false;
  }
  if (model.kinds.length === 0) {
    return true;
  }
  return model.kinds.includes("chat") || model.kinds.includes("audio");
}

export function resolveCanvasRoute(
  model: ChatModelOption | null,
  hasReference: boolean,
): CanvasRouteDecision {
  if (!model) {
    return { route: null, blockedReason: "image_unsupported" };
  }
  const supportsImageGeneration = model.kinds.includes("image_gen");
  const supportsImageEdit = model.kinds.includes("image_edit");
  const canUseChatRoute = modelSupportsChatRoute(model);

  if (hasReference) {
    // media 编辑路由优先；不具备编辑协议时才考虑对话协议回退
    if (supportsImageEdit && modelHasProtocolIn(model, IMAGE_EDIT_PROTOCOLS)) {
      return { route: "image_edit", blockedReason: null };
    }
    // 对话协议生图模型可携带参考图继续走 mixed Chat 请求；普通对话同样采用此行为。
    if (canUseChatRoute && (supportsImageEdit || supportsImageGeneration)) {
      return { route: "chat", blockedReason: null };
    }
    return { route: null, blockedReason: "edit_unsupported" };
  }

  // media 生成路由优先
  if (supportsImageGeneration && modelHasProtocolIn(model, IMAGE_GENERATION_PROTOCOLS)) {
    return { route: "image_generation", blockedReason: null };
  }
  // 无图像生成协议时，仅当模型确实支持 chat 才回退，否则后端会返回 all routes unavailable
  if (supportsImageGeneration && canUseChatRoute) {
    return { route: "chat", blockedReason: null };
  }
  // 图像生成能力搭配了 chat 协议但遗漏 chat kind，明确提示修正模型配置
  if (supportsImageGeneration && modelHasProtocolIn(model, CHAT_PROTOCOLS)) {
    return { route: null, blockedReason: "chat_capability_required" };
  }
  // 仅支持图像编辑的模型禁止纯文本发送
  if (supportsImageEdit) {
    return { route: null, blockedReason: "edit_reference_required" };
  }
  return { route: null, blockedReason: "image_unsupported" };
}

function optionPathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// 汇总当前模型可配置的图像参数控件（协议基础控件 + 管理端下发控件）
export function resolveCanvasImageControls(model: ChatModelOption | null): ModelOptionControl[] {
  if (!model) {
    return [];
  }
  const controlsByPath = new Map<string, ModelOptionControl>();
  const addControl = (control: ModelOptionControl) => {
    const path = optionPathSegments(control.path).join(".");
    if (path && IMAGE_OPTION_PATHS.has(path)) {
      controlsByPath.set(path, { ...control, path });
    }
  };

  for (const protocol of model.protocols) {
    for (const control of PROTOCOL_IMAGE_CONTROLS[protocol.trim().toLowerCase()] ?? []) {
      addControl(control);
    }
  }
  if (isChatRouteImageModel(model)) {
    for (const control of CHAT_ROUTE_IMAGE_CONTROLS) {
      addControl(control);
    }
  }
  for (const control of model.optionControls) {
    addControl(control);
  }
  return [...controlsByPath.values()];
}

export function getOptionAtPath(options: ConversationOptions, path: string[]): unknown {
  let current: unknown = options;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setOptionAtPath(
  options: ConversationOptions,
  path: string[],
  value: unknown,
): ConversationOptions {
  if (path.length === 0) {
    return options;
  }
  const [segment, ...rest] = path;
  if (rest.length === 0) {
    return { ...options, [segment]: value };
  }
  const current = options[segment];
  const nested =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as ConversationOptions)
      : {};
  return { ...options, [segment]: setOptionAtPath(nested, rest, value) };
}

export function deleteOptionAtPath(options: ConversationOptions, path: string[]): ConversationOptions {
  if (path.length === 0) {
    return options;
  }
  const [segment, ...rest] = path;
  const next = { ...options };
  if (rest.length === 0) {
    delete next[segment];
    return next;
  }
  const current = next[segment];
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    return next;
  }
  const nested = deleteOptionAtPath(current as ConversationOptions, rest);
  if (Object.keys(nested).length === 0) {
    delete next[segment];
  } else {
    next[segment] = nested;
  }
  return next;
}

// 合并模型默认参数与用户在画布上选择的图像参数
export function mergeCanvasOptions(
  defaults: ConversationOptions,
  overrides: ConversationOptions,
): ConversationOptions {
  const merged: ConversationOptions = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    const bothPlainObjects =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current);
    merged[key] = bothPlainObjects
      ? mergeCanvasOptions(current as ConversationOptions, value as ConversationOptions)
      : value;
  }
  return merged;
}

// chat 路由图像模型通过提示词后缀传递画幅/尺寸，与普通对话行为一致
export function chatImagePromptSuffix(options: ConversationOptions): string {
  return [options.aspect_ratio, options.image_size]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map((value) => ` --${value}`)
    .join("");
}

export function countActiveImageOptions(
  controls: ModelOptionControl[],
  options: ConversationOptions,
): number {
  return controls.filter((control) => getOptionAtPath(options, optionPathSegments(control.path)) !== undefined)
    .length;
}
