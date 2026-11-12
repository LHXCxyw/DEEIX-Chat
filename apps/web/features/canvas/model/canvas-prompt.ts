// ---------------------------------------------------------------------------
// 画布提示词：@ 素材语法、增强规则与本地优化
// 提示词中的素材引用格式为 @[显示名](fileID)，渲染时显示为缩略图 / 音频气泡，
// 发送给模型前还原成可读的 @显示名，素材本身作为参考内容随请求提交。
// ---------------------------------------------------------------------------
export type CanvasPromptAssetKind = "image" | "video" | "audio" | "file";

export type CanvasPromptSegment =
  | { type: "text"; text: string }
  | { type: "asset"; name: string; fileID: string };

const PROMPT_ASSET_TOKEN = /@\[([^\]\n]{1,80})\]\(([A-Za-z0-9:_\-.]{1,64})\)/g;
const PROMPT_ASSET_TOKEN_ONE = /@\[([^\]\n]{1,80})\]\(([A-Za-z0-9:_\-.]{1,64})\)/;

// 按 @[名称](fileID) 切分提示词，供富文本渲染使用
export function parseCanvasPrompt(text: string): CanvasPromptSegment[] {
  const segments: CanvasPromptSegment[] = [];
  const value = text ?? "";
  let lastIndex = 0;
  PROMPT_ASSET_TOKEN.lastIndex = 0;
  for (const match of value.matchAll(PROMPT_ASSET_TOKEN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: "text", text: value.slice(lastIndex, index) });
    }
    segments.push({ type: "asset", name: match[1], fileID: match[2] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) {
    segments.push({ type: "text", text: value.slice(lastIndex) });
  }
  return segments;
}

export function promptAssetFileIDs(text: string): string[] {
  const ids: string[] = [];
  for (const segment of parseCanvasPrompt(text)) {
    if (segment.type === "asset" && !ids.includes(segment.fileID)) {
      ids.push(segment.fileID);
    }
  }
  return ids;
}

// 模型可读文本：去掉方括号与 fileID，仅保留 @名称
export function promptForModel(text: string): string {
  return (text ?? "").replace(PROMPT_ASSET_TOKEN, "@$1").trim();
}

// 素材序号前缀：模型看不到文件名，只能按「图1 / 视频1 / 音频1」定位提示词中的素材
const ASSET_MARKER_PREFIX: Record<CanvasPromptAssetKind, string> = {
  image: "图",
  video: "视频",
  audio: "音频",
  file: "素材",
};

export type PromptAssetKindResolver = (fileID: string) => CanvasPromptAssetKind | null;

export type PromptAssetTokenInfo = {
  name: string;
  fileID: string;
  kind: CanvasPromptAssetKind;
  marker: string;
};

// 按提示词中出现顺序为素材编号：同一类型从 1 递增，同一文件只编一次
export function promptAssetTokens(
  text: string,
  resolveKind?: PromptAssetKindResolver,
): PromptAssetTokenInfo[] {
  const counters: Record<CanvasPromptAssetKind, number> = { image: 0, video: 0, audio: 0, file: 0 };
  const seen = new Set<string>();
  const tokens: PromptAssetTokenInfo[] = [];
  for (const segment of parseCanvasPrompt(text)) {
    if (segment.type !== "asset" || seen.has(segment.fileID)) {
      continue;
    }
    seen.add(segment.fileID);
    const kind = resolveKind?.(segment.fileID) ?? "file";
    counters[kind] += 1;
    tokens.push({
      name: segment.name,
      fileID: segment.fileID,
      kind,
      marker: `${ASSET_MARKER_PREFIX[kind]}${counters[kind]}`,
    });
  }
  return tokens;
}

// 发送给上游的提示词：素材引用替换为 @图1 / @视频1 等序号标记
export function promptForModelWithAssets(
  text: string,
  resolveKind?: PromptAssetKindResolver,
): string {
  const markers = new Map(promptAssetTokens(text, resolveKind).map((token) => [token.fileID, token.marker]));
  return (text ?? "")
    .replace(PROMPT_ASSET_TOKEN, (_match, _name: string, fileID: string) => `@${markers.get(fileID) ?? "素材"}`)
    .trim();
}

export function promptHasAssets(text: string): boolean {
  return PROMPT_ASSET_TOKEN_ONE.test(text ?? "");
}

// 移除某个素材的全部标记：删除对话框素材时同步清理提示词中的引用
export function removePromptToken(text: string, fileID: string): string {
  const escaped = fileID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`@\\[[^\\]\\n]*\\]\\(${escaped}\\)\\s?`, "g");
  return (text ?? "").replace(pattern, "").trimEnd();
}

// 在光标处插入素材标记；名称中的方括号会被替换，避免破坏语法
export function appendPromptToken(text: string, name: string, fileID: string, caret?: number): { text: string; caret: number } {
  const safeName = (name || "素材").replace(/[[\]\n]/g, "").slice(0, 80) || "素材";
  const token = `@[${safeName}](${fileID})`;
  const value = text ?? "";
  const at = typeof caret === "number" && caret >= 0 && caret <= value.length ? caret : value.length;
  const needsSpace = at > 0 && !/\s$/.test(value.slice(0, at));
  return {
    text: `${value.slice(0, at)}${needsSpace ? " " : ""}${token} ${value.slice(at)}`,
    caret: at + token.length + (needsSpace ? 2 : 1),
  };
}

export function canvasAssetKind(mimeType?: string | null, fileName?: string | null): CanvasPromptAssetKind {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = (fileName ?? "").toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) return "audio";
  return "file";
}

// ---------------------------------------------------------------------------
// 提示词优化：内置图片 / 视频两套增强描述，可在画布右上角菜单中自定义；
// 优化由用户在配置里选择的文本模型完成，未选择模型时不执行优化。
// ---------------------------------------------------------------------------
export type CanvasPromptEnhancement = {
  image: string;
  video: string;
  // 用于重写提示词的文本模型（platformModelName）；空值表示尚未配置
  model: string | null;
};

export const DEFAULT_IMAGE_PROMPT_ENHANCEMENT =
  "主体清晰，构图完整，光影自然，材质细节丰富，色彩协调，高质量画面质感";

export const DEFAULT_VIDEO_PROMPT_ENHANCEMENT =
  "连续镜头，动作连贯，运镜平稳，光影统一，画面稳定无闪烁，细节清晰，电影级质感";

const PROMPT_ENHANCEMENT_STORAGE_KEY = "deeix_canvas_prompt_enhancement_v1";

// 打开提示词优化配置面板：对话框内的「AI 优化」在未配置模型时据此跳到设置面板
export const OPEN_PROMPT_ENHANCEMENT_EVENT = "deeix:canvas:open-prompt-enhancement";

export function requestPromptEnhancementSettings(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(OPEN_PROMPT_ENHANCEMENT_EVENT));
}

function defaultPromptEnhancement(): CanvasPromptEnhancement {
  return {
    image: DEFAULT_IMAGE_PROMPT_ENHANCEMENT,
    video: DEFAULT_VIDEO_PROMPT_ENHANCEMENT,
    model: null,
  };
}

export function loadPromptEnhancement(): CanvasPromptEnhancement {
  if (typeof window === "undefined") {
    return defaultPromptEnhancement();
  }
  try {
    const raw = window.localStorage.getItem(PROMPT_ENHANCEMENT_STORAGE_KEY);
    if (!raw) {
      return defaultPromptEnhancement();
    }
    const parsed: unknown = JSON.parse(raw);
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    return {
      image: typeof record.image === "string" && record.image.trim() ? record.image.trim() : DEFAULT_IMAGE_PROMPT_ENHANCEMENT,
      video: typeof record.video === "string" && record.video.trim() ? record.video.trim() : DEFAULT_VIDEO_PROMPT_ENHANCEMENT,
      model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : null,
    };
  } catch {
    return defaultPromptEnhancement();
  }
}

export function savePromptEnhancement(next: CanvasPromptEnhancement): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PROMPT_ENHANCEMENT_STORAGE_KEY, JSON.stringify({
      image: next.image.trim() || DEFAULT_IMAGE_PROMPT_ENHANCEMENT,
      video: next.video.trim() || DEFAULT_VIDEO_PROMPT_ENHANCEMENT,
      model: next.model?.trim() || null,
    }));
  } catch {
    // 存储失败时静默降级
  }
}

// 把模型重写后的文本还原为画布素材标记：模型只看到「图1 / 视频1」序号，
// 按序号匹配回 @[名称](fileID)；未被引用的素材补在末尾，保证参考内容不丢失。
export function restorePromptAssetTokens(
  original: string,
  optimized: string,
  resolveKind?: PromptAssetKindResolver,
): string {
  const tokens = promptAssetTokens(original, resolveKind);
  if (tokens.length === 0) {
    return (optimized ?? "").trim();
  }
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let text = (optimized ?? "").trim();
  const missing: string[] = [];
  for (const token of tokens) {
    // 序号后不能紧跟数字，避免 @图1 命中 @图12
    const pattern = new RegExp(`@${escapeRegExp(token.marker)}(?!\\d)`);
    if (pattern.test(text)) {
      text = text.replace(pattern, `@[${token.name}](${token.fileID})`);
    } else {
      missing.push(`@[${token.name}](${token.fileID})`);
    }
  }
  return [text, ...missing].filter(Boolean).join(" ").trim();
}

