import {
  ASPECT_RATIO_VALUES,
  IMAGE_OPTION_PATHS,
  IMAGE_SIZE_VALUES,
  isPersonalModelRef,
  resolveModelOptionLabel,
  resolveProtocolImageControls,
  resolveProtocolVideoControls,
  VIDEO_OPTION_PATHS,
} from "@/entities/model";
import type { CanvasMediaType } from "@/features/canvas/model/canvas-types";
import type { ChatModelOption as CanvasModelBaseOption, ModelOptionControl } from "@/features/chat";
import type { ConversationOptions } from "@/shared/api/conversation-types";

// ---------------------------------------------------------------------------
// 画布模型适配层：上游 0.4.4 取消了独立的 modelScope/userModelID/upstream* 字段，
// 改为把用户自带密钥的模型统一编码为 `personal:<provider id>/<model>` 形式的
// platformModelName，并给出 personalProviderName。这里据此外推出画布历史实现依赖的
// 旧字段，使画布内部逻辑无需感知上游编码差异。
// ---------------------------------------------------------------------------
export type CanvasModelOption = CanvasModelBaseOption & {
  modelScope: "platform" | "user";
  userModelID?: number;
  upstreamID?: number;
  upstreamName?: string;
  upstreamCompatible?: string;
  // 用户自带密钥的提供商名与图标：上游同名字段，画布分组与徽标直接透传使用
  personalProviderName: string | null;
  personalProviderIcon: string;
};

// 确定性哈希：把上游模型的唯一名称映射为正整数标识，跨会话/刷新可复现（0 视为未设置）。
function stableCanvasModelID(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) || 1;
}

// 由上游模型条目派生画布扩展字段。
export function toCanvasModelOption(model: CanvasModelBaseOption): CanvasModelOption {
  const personalProviderName = model.personalProviderName?.trim() || "";
  const isUserModel = Boolean(personalProviderName) || isPersonalModelRef(model.platformModelName);
  if (!isUserModel) {
    return { ...model, modelScope: "platform" };
  }
  return {
    ...model,
    modelScope: "user",
    userModelID: stableCanvasModelID(model.platformModelName),
    upstreamName: personalProviderName || resolveModelOptionLabel(model.platformModelName),
  };
}

// 画布请求路由：media 图像生成 / media 图像编辑 / chat 路由图像模型 / media 视频生成
export type CanvasRoute = "image_generation" | "image_edit" | "chat" | "video_generation";

// ---------------------------------------------------------------------------
// 模型身份键：同一模型名可能存在于多个接口（用户模型按上游渠道重复），
// 选择与解析都以身份键为准，避免同名模型无法区分来源接口
// ---------------------------------------------------------------------------
export function canvasModelKey(model: Pick<CanvasModelOption, "platformModelName" | "modelScope" | "userModelID" | "upstreamID">): string {
  return model.modelScope === "user"
    ? `user:${model.userModelID ?? model.upstreamID ?? model.platformModelName}`
    : `platform:${model.platformModelName}`;
}

// 身份键解析：还原作用域与用户模型 ID（模型名单独存放在节点/状态字段中）
export function parseCanvasModelKey(key: string | null | undefined): { scope: "platform" | "user"; userModelID?: number } {
  if (key && key.startsWith("user:")) {
    const id = Number(key.slice(5));
    return { scope: "user", userModelID: Number.isFinite(id) && id > 0 ? id : undefined };
  }
  return { scope: "platform" };
}

export type CanvasRouteBlockReason =
  | "edit_reference_required"
  | "image_unsupported"
  | "edit_unsupported"
  | "video_unsupported"
  | "video_too_many_references";

export type CanvasRouteDecision =
  | { route: CanvasRoute; blockedReason: null }
  | { route: null; blockedReason: CanvasRouteBlockReason };

// chat 路由图像模型的通用提示词参数（与普通对话的画图参数一致）
const CHAT_ROUTE_IMAGE_CONTROLS: ModelOptionControl[] = [
  { path: "aspect_ratio", type: "select", options: ASPECT_RATIO_VALUES },
  { path: "image_size", type: "select", options: IMAGE_SIZE_VALUES },
];

// 视频协议白名单：与后端 IsRouteAllowedForTask(video_generation) 的 isProtocolAllowedForKind 保持一致
const VIDEO_GENERATION_PROTOCOLS = new Set([
  "xai_video",
  "openai_video_generations",
  "gemini_interactions",
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

// 编辑协议集合与后端 IsRouteAllowedForTask 的 isProtocolAllowedForKind(image_edit) 保持一致。
// openai_image_generations 的适配器会按任务端点切换到 /images/edits 执行编辑请求。
const IMAGE_EDIT_PROTOCOLS = new Set([
  "openai_image_edits",
  "openai_image_generations",
  "google_image_generation",
  "gemini_interactions",
  "xai_image_edits",
  "image_edits_json",
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

function modelHasProtocolIn(model: CanvasModelOption | null, allowed: Set<string>): boolean {
  return Boolean(
    model?.protocols.some((protocol) => allowed.has(protocol.trim().toLowerCase())),
  );
}

// 模型是否具备任一图像协议（生成或编辑）
export function modelHasImageProtocol(model: CanvasModelOption | null): boolean {
  return modelHasProtocolIn(model, IMAGE_GENERATION_PROTOCOLS)
    || modelHasProtocolIn(model, IMAGE_EDIT_PROTOCOLS);
}

// 模型是否真正可走 media 图像编辑路由（kinds 与编辑协议缺一不可）。
// 仅凭 kinds 含 image_edit 判定会误导：协议不在白名单时后端无法路由。
export function modelSupportsImageEditRoute(model: CanvasModelOption | null): boolean {
  return Boolean(model?.kinds.includes("image_edit")) && modelHasProtocolIn(model, IMAGE_EDIT_PROTOCOLS);
}

// chat 路由图像模型：有图像能力但没有图像协议，只能走对话协议并用提示词后缀传参
export function isChatRouteImageModel(model: CanvasModelOption | null): boolean {
  if (!model) {
    return false;
  }
  const supportsImage = model.kinds.includes("image_gen") || model.kinds.includes("image_edit");
  return supportsImage && !modelHasImageProtocol(model);
}

// chat 路由判定：后端 chat 任务仅校验协议是否已知（IsRouteAllowedForTask 不检查 kinds），
// 因此对话协议的图像模型（含 image_gen / image_edit kinds）可直接走对话路由生图与识图编辑。
function modelSupportsChatRoute(model: CanvasModelOption): boolean {
  return modelHasProtocolIn(model, CHAT_PROTOCOLS);
}

export function resolveCanvasRoute(
  model: CanvasModelOption | null,
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
    if (modelSupportsImageEditRoute(model)) {
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
  // 无图像生成协议时走对话路由：对话协议图像模型直接经 chat 请求生图
  if (supportsImageGeneration && canUseChatRoute) {
    return { route: "chat", blockedReason: null };
  }
  // 仅支持图像编辑的模型禁止纯文本发送
  if (supportsImageEdit) {
    return { route: null, blockedReason: "edit_reference_required" };
  }
  return { route: null, blockedReason: "image_unsupported" };
}

// 视频模型判定：kinds 含 video_gen 且协议在视频白名单内（与后端路由约束一致）
export function modelSupportsVideoRoute(model: CanvasModelOption | null): boolean {
  return Boolean(model?.kinds.includes("video_gen")) && modelHasProtocolIn(model, VIDEO_GENERATION_PROTOCOLS);
}

// 模型的画布媒体类型：视频模型归为 video，其余按图像处理
export function modelCanvasMediaType(model: CanvasModelOption | null): CanvasMediaType {
  return modelSupportsVideoRoute(model) ? "video" : "image";
}

// 按节点媒体类型解析生成路由；视频仅支持 generate 操作（参考图上限 7 张）
export function resolveCanvasMediaRoute(
  model: CanvasModelOption | null,
  mediaType: CanvasMediaType,
  referenceCount: number,
): CanvasRouteDecision {
  if (mediaType === "video") {
    if (!modelSupportsVideoRoute(model)) {
      return { route: null, blockedReason: "video_unsupported" };
    }
    if (referenceCount > 7) {
      return { route: null, blockedReason: "video_too_many_references" };
    }
    return { route: "video_generation", blockedReason: null };
  }
  return resolveCanvasRoute(model, referenceCount > 0);
}

// 汇总当前视频模型可配置的参数控件（协议基础控件 + 管理端下发控件）
export function resolveCanvasVideoControls(model: CanvasModelOption | null): ModelOptionControl[] {
  if (!model) {
    return [];
  }
  const controlsByPath = new Map<string, ModelOptionControl>();
  const addControl = (control: ModelOptionControl) => {
    const path = optionPathSegments(control.path).join(".");
    if (path && VIDEO_OPTION_PATHS.has(path)) {
      controlsByPath.set(path, { ...control, path });
    }
  };
  for (const control of resolveProtocolVideoControls(model.protocols)) {
    addControl(control);
  }
  for (const control of model.optionControls) {
    addControl(control);
  }
  return [...controlsByPath.values()];
}

function optionPathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// 汇总当前模型可配置的图像参数控件（协议基础控件 + 管理端下发控件）
export function resolveCanvasImageControls(model: CanvasModelOption | null): ModelOptionControl[] {
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

  for (const control of resolveProtocolImageControls(model.protocols)) {
    addControl(control);
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

// 按媒体类型取参数控件
export function resolveCanvasMediaControls(
  model: CanvasModelOption | null,
  mediaType: CanvasMediaType,
): ModelOptionControl[] {
  return mediaType === "video"
    ? resolveCanvasVideoControls(model)
    : resolveCanvasImageControls(model);
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

// ---------------------------------------------------------------------------
// 编辑器尺寸同步：把编辑界面（扩图/裁剪）计算出的输出尺寸映射为模型的尺寸类参数，
// 使自动创建/复用的生成节点与编辑器设置保持一致
// ---------------------------------------------------------------------------
function parseAspectRatio(value: string): number | null {
  const match = value.match(/^([\d.]+)\s*[:x/]\s*([\d.]+)$/);
  if (!match) {
    return null;
  }
  const denominator = Number(match[2]);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  const ratio = Number(match[1]) / denominator;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

// 在候选枚举里找与目标宽高比最接近的值（对数距离衡量，比例失真在大小两端对称）
function closestAspectRatioValue(values: string[], ratio: number): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value.trim().toLowerCase() === "auto") {
      continue;
    }
    const target = parseAspectRatio(value);
    if (target === null) {
      continue;
    }
    const score = Math.abs(Math.log(ratio / target));
    if (score < bestScore) {
      bestScore = score;
      best = value;
    }
  }
  return best;
}

// 按百万像素挑最接近的分辨率档位（1K≈1MP、2K≈4MP、4K≈16MP）
function closestResolutionTier(values: string[], megapixels: number): string | null {
  const tiers: Record<string, number> = { "1k": 1, "2k": 4, "4k": 16 };
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const target = tiers[value.trim().toLowerCase()];
    if (target === undefined) {
      continue;
    }
    const score = Math.abs(Math.log(megapixels / target));
    if (score < bestScore) {
      bestScore = score;
      best = value;
    }
  }
  return best;
}

export function editorSizeOptions(
  model: CanvasModelOption | null,
  width: number,
  height: number,
): ConversationOptions {
  if (!model || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {};
  }
  const ratio = width / height;
  const megapixels = (width * height) / 1_000_000;
  let options: ConversationOptions = {};
  for (const control of resolveCanvasImageControls(model)) {
    const values = (control.options ?? []).map((item) => item.trim()).filter(Boolean);
    if (values.length === 0) {
      continue;
    }
    if (/aspect_?ratio$/i.test(control.path)) {
      const matched = closestAspectRatioValue(values, ratio);
      if (matched) {
        options = setOptionAtPath(options, optionPathSegments(control.path), matched);
      }
      continue;
    }
    // "1024x1024" 形态的 size 枚举（OpenAI / image_edits_json）
    if (control.path === "size" && values.some((value) => parseAspectRatio(value) !== null)) {
      const matched = closestAspectRatioValue(values, ratio);
      if (matched) {
        options = setOptionAtPath(options, ["size"], matched);
      }
      continue;
    }
    // 1K/2K/4K 档位（image_size / imageSize / resolution 等）
    const tier = closestResolutionTier(values, megapixels);
    if (tier) {
      options = setOptionAtPath(options, optionPathSegments(control.path), tier);
    }
  }
  return options;
}
