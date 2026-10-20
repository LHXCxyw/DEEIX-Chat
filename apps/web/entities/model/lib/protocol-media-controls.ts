// ---------------------------------------------------------------------------
// 协议制媒体参数：图像与视频生成/编辑协议对应的可视化参数控件。
// 这是媒体参数的唯一事实来源，画布参数面板与聊天 composer 共用同一张表与解析函数。
// 注意：本文件位于实体层，不能依赖 features/，因此这里自定义 ProtocolMediaOptionControl，
// 其结构与 features/chat 的 ModelOptionControl 保持一致（结构化类型，可互相赋值）。
// ---------------------------------------------------------------------------

/** 媒体参数控件：与 features/chat 的 ModelOptionControl 结构一致。 */
export type ProtocolMediaOptionControl = {
  path: string;
  label?: string;
  description?: string;
  type?: "boolean" | "number" | "select" | "text";
  options?: string[];
  placeholder?: string;
  locked?: boolean;
};

export const ASPECT_RATIO_VALUES = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export const IMAGE_SIZE_VALUES = ["1K", "2K", "4K"];
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
export const PROTOCOL_IMAGE_CONTROLS: Record<string, ProtocolMediaOptionControl[]> = {
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
  // image_edits_json：size 为宽高像素组合（auto 或 32 倍数），response_format 与 OpenAI 命名一致
  image_edits_json: [
    {
      path: "size",
      type: "select",
      options: ["auto", "2048x2048", "2720x1536", "1536x2720", "1664x2496", "2496x1664", "4096x4096"],
    },
    { path: "response_format", type: "select", options: ["b64_json", "url"] },
  ],
};

// 各视频协议对应的可视化参数控件（与后端视频参数清洗逻辑对齐）。
// openai_video_generations 的本地参数键与上游请求字段一一对应（ratio / seconds / resolution_name / mode），
// 不存在「本地键 → 上游字段」的映射层；其中 size 由服务端根据 resolution_name + ratio 推导，故不设控件，
// generate_audio / watermark 仅作直通，同样不设控件。
// resolution 除预设外支持在参数面板输入自定义值，后端放行 NNNp / Nk / 宽x高 格式。
const VIDEO_ASPECT_RATIO_VALUES = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
// OpenAI 兼容视频协议额外支持 21:9（xAI 协议不接受该比例，故单列）。
const OPENAI_VIDEO_ASPECT_RATIO_VALUES = [...VIDEO_ASPECT_RATIO_VALUES, "21:9"];
const VIDEO_RESOLUTION_VALUES = ["420p", "480p", "512p", "720p", "768p", "1080p", "2k"];
export const PROTOCOL_VIDEO_CONTROLS: Record<string, ProtocolMediaOptionControl[]> = {
  xai_video: [
    { path: "aspect_ratio", type: "select", options: VIDEO_ASPECT_RATIO_VALUES },
    { path: "duration", type: "number" },
    { path: "resolution", type: "select", options: VIDEO_RESOLUTION_VALUES },
  ],
  openai_video_generations: [
    { path: "ratio", type: "select", options: OPENAI_VIDEO_ASPECT_RATIO_VALUES },
    { path: "seconds", type: "number" },
    { path: "resolution_name", type: "select", options: VIDEO_RESOLUTION_VALUES },
    // 首尾帧模式把前两张参考图分别作为首帧与尾帧（此时最多两张图且不能传参考视频）；全参考模式把参考图作为多张参考素材。
    { path: "mode", type: "select", options: ["frames", "reference"] },
  ],
  gemini_interactions: [
    { path: "generation_config.video_config.duration_seconds", type: "number" },
  ],
};

export const VIDEO_OPTION_PATHS = new Set([
  "aspect_ratio",
  "duration",
  "mode",
  "ratio",
  "resolution",
  "resolution_name",
  "seconds",
  "size",
  "generation_config.video_config.duration_seconds",
  "generationConfig.videoConfig.durationSeconds",
]);

export const IMAGE_OPTION_PATHS = new Set([
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

function optionPathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// 按协议合并图像参数控件：按协议顺序合并、按路径去重，仅保留图像参数路径白名单。
export function resolveProtocolImageControls(protocols: readonly string[]): ProtocolMediaOptionControl[] {
  const byPath = new Map<string, ProtocolMediaOptionControl>();
  for (const protocol of protocols) {
    for (const control of PROTOCOL_IMAGE_CONTROLS[protocol.trim().toLowerCase()] ?? []) {
      const path = optionPathSegments(control.path).join(".");
      if (path && IMAGE_OPTION_PATHS.has(path)) {
        byPath.set(path, { ...control, path });
      }
    }
  }
  return [...byPath.values()];
}

// 按协议合并视频参数控件：按协议顺序合并、按路径去重，仅保留视频参数路径白名单。
export function resolveProtocolVideoControls(protocols: readonly string[]): ProtocolMediaOptionControl[] {
  const byPath = new Map<string, ProtocolMediaOptionControl>();
  for (const protocol of protocols) {
    for (const control of PROTOCOL_VIDEO_CONTROLS[protocol.trim().toLowerCase()] ?? []) {
      const path = optionPathSegments(control.path).join(".");
      if (path && VIDEO_OPTION_PATHS.has(path)) {
        byPath.set(path, { ...control, path });
      }
    }
  }
  return [...byPath.values()];
}
