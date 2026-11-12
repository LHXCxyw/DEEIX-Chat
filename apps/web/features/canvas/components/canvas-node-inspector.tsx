"use client";

import {
  AudioLines,
  Check,
  ChevronDown,
  Clapperboard,
  FileImage,
  Film,
  ImageIcon,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import { edgeAssetsForNode, type CanvasAssetEntry } from "@/features/canvas/model/canvas-assets";
import {
  deleteOptionAtPath,
  getOptionAtPath,
  resolveCanvasMediaControls,
  setOptionAtPath,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import {
  canvasAssetKind,
  loadPromptEnhancement,
  parseCanvasPrompt,
  promptAssetTokens,
  promptForModelWithAssets,
  removePromptToken,
  requestPromptEnhancementSettings,
  restorePromptAssetTokens,
  type CanvasPromptAssetKind,
} from "@/features/canvas/model/canvas-prompt";
import type {
  CanvasNodeReference,
  GenerateGraphNode,
  GraphEdge,
  GraphNode,
  GraphNodeUpdate,
} from "@/features/canvas/model/canvas-types";
import type { ModelOptionControl } from "@/features/chat";
import { streamTemporaryChatMessage } from "@/shared/api/conversation";
import type { ConversationOptions } from "@/shared/api/conversation-types";
import { useAuthSession } from "@/shared/auth/auth-session-context";
import { cn } from "@/lib/utils";

export type CanvasNodeInspectorHandlers = {
  onUpdateNode: (nodeID: string, patch: GraphNodeUpdate) => void;
  onRunNode: (nodeID: string) => void;
  onRemoveEdge: (edgeID: string) => void;
  onPreviewAsset: (asset: CanvasAssetEntry) => void;
  // 添加素材时同步在节点图中创建/复用素材节点并连线
  onAttachAsset: (nodeID: string, reference: CanvasNodeReference, kind: CanvasPromptAssetKind, previewURL?: string) => void;
  uploadReferenceFile: (file: File) => Promise<{ fileID: string; fileName: string; mimeType: string; sizeBytes: number; previewURL?: string } | null>;
  onClose: () => void;
};

type AssetChipEntry = CanvasAssetEntry & { edgeID?: string; local?: boolean };

function assetIcon(kind: string) {
  if (kind === "video") return Film;
  if (kind === "audio") return AudioLines;
  if (kind === "image") return ImageIcon;
  return FileImage;
}

// 节点自带预览地址：参考图 / 媒体取缓存的 objectURL，生成结果取输出产物地址
function nodePreviewURL(node: GraphNode): string | undefined {
  if (node.kind === "image" || node.kind === "media") {
    return node.previewURL;
  }
  if (node.kind === "output") {
    return node.objectURL;
  }
  return undefined;
}

// 素材缩略图：图像显示小图，视频取首帧封面并悬停静音自动播放，音频显示波形气泡
function AssetPreview({ entry, size = "md" }: { entry: Pick<CanvasAssetEntry, "kind" | "previewURL" | "reference">; size?: "sm" | "md" }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const classes = size === "sm" ? "size-9" : "size-12";
  const start = () => {
    void videoRef.current?.play().catch(() => {});
    void audioRef.current?.play().catch(() => {});
  };
  const stop = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };
  if (entry.kind === "audio") {
    return (
      <span
        className={cn("flex items-center justify-center rounded-full bg-fuchsia-500/10 text-fuchsia-600", classes)}
        onMouseEnter={start}
        onMouseLeave={stop}
      >
        {entry.previewURL ? <audio ref={audioRef} src={entry.previewURL} preload="metadata" className="hidden"><track kind="captions" /></audio> : <AudioLines className="size-4" strokeWidth={1.8} />}
        <AudioLines className="size-4" strokeWidth={1.8} />
      </span>
    );
  }
  if (entry.kind === "video") {
    return (
      <span className={cn("relative overflow-hidden rounded-md bg-muted", classes)} onMouseEnter={start} onMouseLeave={stop}>
        {entry.previewURL ? (
          <video ref={videoRef} src={entry.previewURL} muted loop playsInline preload="metadata" className="size-full object-cover">
            <track kind="captions" />
          </video>
        ) : (
          <span className="flex size-full items-center justify-center text-violet-500"><Film className="size-4" strokeWidth={1.8} /></span>
        )}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/25">
          <Play className="size-3 text-foreground/80" strokeWidth={2} />
        </span>
      </span>
    );
  }
  if (entry.kind === "image" && entry.previewURL) {
    return (
      <span className={cn("overflow-hidden rounded-md bg-muted", classes)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={entry.previewURL} alt="" className="size-full object-cover" draggable={false} />
      </span>
    );
  }
  const Icon = assetIcon(entry.kind);
  return <span className={cn("flex items-center justify-center rounded-md bg-muted text-muted-foreground", classes)}><Icon className="size-4" strokeWidth={1.8} /></span>;
}

function AssetChip({ entry, onRemove }: { entry: AssetChipEntry; onRemove?: () => void }) {
  const t = useTranslations("canvas.nodeInspector");
  return (
    <span
      data-canvas-selectable
      title={entry.reference.fileName}
      className="group/chip relative inline-flex size-11 shrink-0 items-center justify-center"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="size-11 overflow-hidden rounded-xl bg-muted/50 ring-1 ring-border/40 transition-shadow group-hover/chip:ring-primary/40">
        <AssetPreview entry={entry} size="sm" />
      </span>
      {onRemove ? (
        <button
          type="button"
          aria-label={t("removeAsset")}
          title={t("removeAsset")}
          className="absolute -right-1 -top-1 rounded-full bg-background p-0.5 text-muted-foreground opacity-0 shadow-sm ring-1 ring-border/60 transition-opacity hover:text-destructive group-hover/chip:opacity-100"
          onClick={onRemove}
        >
          <X className="size-2.5" strokeWidth={2.5} />
        </button>
      ) : null}
    </span>
  );
}

function AssetPickerList({
  assets,
  onPick,
  emptyLabel,
  maxHeight = 256,
}: {
  assets: ReadonlyArray<CanvasAssetEntry>;
  onPick: (asset: CanvasAssetEntry) => void;
  emptyLabel: string;
  maxHeight?: number;
}) {
  if (assets.length === 0) {
    return <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-1 overflow-y-auto overscroll-contain p-1" style={{ maxHeight }}>
      {assets.map((asset) => (
        <button
          key={asset.reference.fileID}
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-accent"
          onClick={() => onPick(asset)}
        >
          <AssetPreview entry={asset} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-foreground/90">{asset.reference.fileName}</span>
            <span className="block text-[10px] text-muted-foreground">{asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : asset.kind === "image" ? "图片" : "文件"}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// 素材标记的行内图标（用 SVG 直接写入 DOM，避免在 contentEditable 中混入 React 节点）
const PROMPT_TOKEN_ICONS: Record<CanvasPromptAssetKind, string> = {
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};

type PromptEditorHandle = {
  focus: () => void;
  insertAsset: (asset: CanvasAssetEntry) => void;
};

const PROMPT_TOKEN_CLASS = "mx-0.5 inline-flex max-w-[12rem] cursor-default items-center gap-1 rounded-md bg-background/90 py-0.5 pl-0.5 pr-1.5 align-middle text-[11px] text-foreground/85 shadow-sm ring-1 ring-border/50";

// 构建行内素材标记：图片 / 视频显示小图预览，音频显示小气泡
function buildPromptTokenNode(fileID: string, name: string, kind: CanvasPromptAssetKind, previewURL?: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.fileId = fileID;
  span.dataset.assetName = name;
  span.className = PROMPT_TOKEN_CLASS;
  span.title = name;
  if (previewURL && (kind === "image" || kind === "video")) {
    if (kind === "video") {
      // 视频素材用静音 video 取首帧，避免 <img> 无法解析视频地址导致空白
      const video = document.createElement("video");
      video.src = previewURL;
      video.muted = true;
      video.preload = "metadata";
      video.className = "size-5 shrink-0 rounded-[4px] object-cover";
      span.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = previewURL;
      img.alt = "";
      img.draggable = false;
      img.className = "size-5 shrink-0 rounded-[4px] object-cover";
      span.appendChild(img);
    }
  } else {
    const icon = document.createElement("span");
    icon.className = kind === "audio"
      ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-fuchsia-500/10 text-fuchsia-600 [&>svg]:size-3"
      : "flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-muted text-muted-foreground [&>svg]:size-3";
    icon.innerHTML = PROMPT_TOKEN_ICONS[kind] ?? PROMPT_TOKEN_ICONS.file;
    span.appendChild(icon);
  }
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = name;
  span.appendChild(label);
  return span;
}

// 富文本提示词编辑器：始终按 @[名称](fileID) 解析渲染，编辑时也保持素材小图 / 音频气泡
const PromptEditor = React.forwardRef<PromptEditorHandle, {
  value: string;
  assets: ReadonlyArray<CanvasAssetEntry>;
  onChange: (next: string) => void;
  onMention: () => void;
}>(function PromptEditor({ value, assets, onChange, onMention }, ref) {
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const lastValueRef = React.useRef(value);
  // 记录最近一次编辑光标位置：点击素材面板会让编辑器失焦，插入时据此恢复位置
  const lastRangeRef = React.useRef<Range | null>(null);
  const assetMap = React.useMemo(() => new Map(assets.map((item) => [item.reference.fileID, item])), [assets]);

  const rememberSelection = React.useCallback(() => {
    const root = editorRef.current;
    const selection = window.getSelection();
    if (root && selection && selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).startContainer)) {
      lastRangeRef.current = selection.getRangeAt(0).cloneRange();
    }
  }, []);

  const serialize = React.useCallback((): string => {
    const root = editorRef.current;
    if (!root) return "";
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const element = node as HTMLElement;
      if (element.dataset.fileId) return `@[${element.dataset.assetName ?? ""}](${element.dataset.fileId})`;
      if (element.tagName === "BR") return "\n";
      let text = "";
      for (const child of Array.from(node.childNodes)) text += walk(child);
      return element.tagName === "DIV" || element.tagName === "P" ? `\n${text}` : text;
    };
    return Array.from(root.childNodes).map(walk).join("").replace(/^\n+/, "").replace(/\n+$/, "");
  }, []);

  const render = React.useCallback((text: string) => {
    const root = editorRef.current;
    if (!root) return;
    const fragment = document.createDocumentFragment();
    for (const segment of parseCanvasPrompt(text)) {
      if (segment.type === "text") {
        const lines = segment.text.split("\n");
        lines.forEach((line, index) => {
          if (index > 0) fragment.appendChild(document.createElement("br"));
          if (line) fragment.appendChild(document.createTextNode(line));
        });
        continue;
      }
      const asset = assetMap.get(segment.fileID);
      fragment.appendChild(buildPromptTokenNode(segment.fileID, segment.name, asset?.kind ?? "file", asset?.previewURL));
    }
    root.replaceChildren(fragment);
    lastValueRef.current = text;
  }, [assetMap]);

  React.useEffect(() => {
    render(value);
    // 仅初始化时按外部值渲染一次，后续同步由 value 变更逻辑处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (value === lastValueRef.current) return;
    // 外部变更（优化、文本节点填充、切换节点）总是重绘；输入回写不会进入这里
    render(value);
  }, [render, value]);

  // 删除光标前的 @查询片段，避免插入素材后残留第二个 @
  const stripMentionQuery = (range: Range) => {
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return range;
    const textNode = range.startContainer as Text;
    const value = textNode.nodeValue ?? "";
    const before = value.slice(0, range.startOffset);
    const match = /@[^\s@]*$/.exec(before);
    if (!match) return range;
    const start = range.startOffset - match[0].length;
    textNode.nodeValue = value.slice(0, start) + value.slice(range.startOffset);
    const next = document.createRange();
    next.setStart(textNode, start);
    next.collapse(true);
    return next;
  };

  React.useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    insertAsset: (asset) => {
      const root = editorRef.current;
      if (!root) return;
      // 优先使用编辑器内的当前光标位置；失焦后回退到最近记录的位置
      const selection = window.getSelection();
      let range: Range | null = null;
      if (selection && selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).startContainer)) {
        range = selection.getRangeAt(0).cloneRange();
      } else if (lastRangeRef.current && root.contains(lastRangeRef.current.startContainer)) {
        range = lastRangeRef.current.cloneRange();
      }
      root.focus();
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(root);
        range.collapse(false);
      }
      range = stripMentionQuery(range);
      range.deleteContents();
      const token = buildPromptTokenNode(asset.reference.fileID, asset.reference.fileName, asset.kind, asset.previewURL);
      const spacer = document.createTextNode("\u00A0");
      range.insertNode(spacer);
      range.insertNode(token);
      const caret = document.createRange();
      caret.setStartAfter(spacer);
      caret.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(caret);
      const next = serialize();
      lastValueRef.current = next;
      onChange(next);
    },
  }), [onChange, serialize]);

  const sync = () => {
    const next = serialize();
    lastValueRef.current = next;
    onChange(next);
  };

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      data-canvas-selectable
      role="textbox"
      tabIndex={0}
      aria-multiline="true"
      className="min-h-[72px] max-h-[168px] overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-6 outline-none"
      onInput={() => {
        sync();
        rememberSelection();
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return;
        const before = (range.startContainer.nodeValue ?? "").slice(0, range.startOffset);
        if (/@[^\s@]*$/.test(before)) onMention();
      }}
      onKeyUp={rememberSelection}
      onMouseUp={rememberSelection}
      onBlur={rememberSelection}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        sync();
      }}
    />
  );
});

// 参数角色：按路径最后一段精确识别，避免把 moderation 之类包含 ratio 的字段误判成画面比例
type ParamControlKind = "ratio" | "resolution" | "size" | "duration" | "mode" | "outputFormat" | "frameCount" | "other";

function controlPathKey(control: ModelOptionControl): string {
  const segments = control.path.split(".").filter(Boolean);
  return (segments[segments.length - 1] ?? control.path).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function controlKind(control: ModelOptionControl): ParamControlKind {
  const key = controlPathKey(control);
  if (key === "duration" || key === "seconds" || key === "videoduration" || key === "durationseconds") return "duration";
  if (key === "ratio" || key === "aspectratio") return "ratio";
  if (key === "size" || key === "imagesize" || key === "mediasize" || key === "outputsize" || key === "videosize") {
    // 部分协议的 size 实际是 1K / 2K / 4K 档位（如 Gemini imageSize），应作为分辨率处理
    const options = (control.options ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (options.length > 0 && options.every((item) => /^\d+(?:\.\d+)?k$/.test(item))) {
      return "resolution";
    }
    return "size";
  }
  if (key === "resolution" || key === "resolutionname" || key === "mediaresolution") return "resolution";
  if (key === "mode" || key === "referencemode" || key === "refmode" || key === "reference") return "mode";
  if (key === "outputformat") return "outputFormat";
  if (key === "framecount") return "frameCount";
  return "other";
}

// GIF 输出专属参数：只有输出格式选择 GIF 时才展示
const GIF_ONLY_VALUE_KEYS = new Set(["framecount", "framedurationms"]);

// 参数值本地化：模型协议里的英文枚举统一显示为中文（大小写不敏感）
const PARAM_VALUE_LABELS: Record<string, string> = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
  standard: "标准",
  hd: "高清",
  opaque: "不透明",
  transparent: "透明",
  gif: "GIF",
  png: "PNG",
  jpeg: "JPG",
  jpg: "JPG",
  webp: "WebP",
  text: "文本",
  image: "图像",
  audio: "音频",
  video: "视频",
  url: "链接",
  b64json: "Base64",
  urlb64json: "链接 / Base64",
  imagepng: "PNG",
  imagejpeg: "JPG",
  imagewebp: "WebP",
  frames: "首尾帧模式",
  frame: "首尾帧模式",
  reference: "全能参考模式",
  ref: "全能参考模式",
  allreference: "全能参考模式",
  firstframe: "首帧模式",
  firstlastframe: "首尾帧模式",
  lastframe: "尾帧模式",
};

function optionValueLabel(value: string): string {
  return PARAM_VALUE_LABELS[value.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? value;
}

// 比例图标：在 20×20 的方框内按真实比例缩放，纵向比例之间也能看出差异
function RatioGlyph({ value }: { value: string }) {
  const [width, height] = value.split(":").map((item) => Number(item));
  const ratio = width && height ? width / height : 1;
  const box = 20;
  const w = ratio >= 1 ? box : box * ratio;
  const h = ratio >= 1 ? box / ratio : box;
  return <span aria-hidden="true" className="inline-block rounded-[3px] border border-current" style={{ width: w, height: h }} />;
}

const DEFAULT_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];

// 分辨率档位：图片按方形基准边长，视频按短边 P 值
const IMAGE_SIZE_TIERS = [{ id: "1K", base: 1024 }, { id: "2K", base: 2048 }, { id: "4K", base: 2880 }];

function parseSizeValue(value: string): { width: number; height: number } | null {
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(value.trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function ratioLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height) || 1;
  return `${width / divisor}:${height / divisor}`;
}

function parseRatio(value: string): { width: number; height: number } | null {
  const match = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(value.trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

// 图片尺寸：长边取分辨率档位，按比例计算短边
function imageSizeForTier(base: number, ratio: string): { width: number; height: number } {
  const parsed = parseRatio(ratio) ?? { width: 1, height: 1 };
  const isLandscape = parsed.width >= parsed.height;
  return {
    width: Math.round(isLandscape ? base : base * parsed.width / parsed.height),
    height: Math.round(isLandscape ? base * parsed.height / parsed.width : base),
  };
}

// 视频分辨率：P 值表示短边，按比例计算长边
function videoSizeForHeight(height: number, ratio: string): { width: number; height: number } {
  const parsed = parseRatio(ratio) ?? { width: 16, height: 9 };
  const isLandscape = parsed.width >= parsed.height;
  return {
    width: Math.round(isLandscape ? height * parsed.width / parsed.height : height),
    height: Math.round(isLandscape ? height : height * parsed.height / parsed.width),
  };
}

// 参数块重置：把该参数恢复为模型默认（删除本地值）
function ParamResetButton({ visible, onReset }: { visible: boolean; onReset: () => void }) {
  const t = useTranslations("canvas.nodeInspector");
  if (!visible) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label={t("resetParam")}
      title={t("resetParam")}
      className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
      onClick={onReset}
    >
      <RotateCcw className="size-3" strokeWidth={1.8} />
    </button>
  );
}

// 参数面板：只展示没有在对话框底部常驻的参数；GIF 专属参数仅在输出格式为 GIF 时出现
function NodeParamsPanel({
  controls,
  options,
  mediaType,
  resultCount,
  showResultCount = false,
  onResultCountChange,
  onOptionsChange,
}: {
  controls: ModelOptionControl[];
  options: ConversationOptions;
  // 媒体类型：视频的分辨率需要同步写 size 字段
  mediaType: "image" | "video";
  // 生成数量：与模型参数一起收进「更多参数」面板
  resultCount?: number;
  showResultCount?: boolean;
  onResultCountChange?: (next: number) => void;
  onOptionsChange: (next: ConversationOptions) => void;
}) {
  const t = useTranslations("canvas.nodeInspector");
  const update = (path: string, value: unknown) => {
    const segments = path.split(".").map((item) => item.trim()).filter(Boolean);
    onOptionsChange(value === undefined ? deleteOptionAtPath(options, segments) : setOptionAtPath(options, segments, value));
  };
  const outputFormat = controls.find((item) => controlKind(item) === "outputFormat");
  const gifActive = outputFormat
    ? String(getOptionAtPath(options, outputFormat.path.split(".")) ?? "").toLowerCase() === "gif"
    : false;
  // 帧数与帧间隔是 GIF 输出专属参数，未选择 GIF 时不展示
  const others = controls.filter((item) => !(GIF_ONLY_VALUE_KEYS.has(controlPathKey(item)) && !gifActive));
  // GIF 的帧数与帧间隔并排显示，其余参数逐行展示
  const gifControls = others.filter((item) => GIF_ONLY_VALUE_KEYS.has(controlPathKey(item)));
  const regularControls = others.filter((item) => !GIF_ONLY_VALUE_KEYS.has(controlPathKey(item)));
  // 分辨率自定义 P 值时，按当前宽高比显示对应的宽高尺寸
  const ratioControl = controls.find((item) => controlKind(item) === "ratio");
  const sizeControl = controls.find((item) => controlKind(item) === "size");
  const rawSize = sizeControl ? parseSizeValue(String(getOptionAtPath(options, sizeControl.path.split(".")) ?? "")) : null;
  const currentRatio = ratioControl
    ? String(getOptionAtPath(options, ratioControl.path.split(".")) ?? "16:9")
    : rawSize ? ratioLabel(rawSize.width, rawSize.height) : "16:9";

  const renderControl = (control: ModelOptionControl) => {
    const value = getOptionAtPath(options, control.path.split("."));
    const opts = (control.options ?? []).map((item) => item.trim()).filter(Boolean);
    const controlValue = value === undefined || value === null || value === "" ? undefined : String(value);
    // 分辨率：档位 / P 值预设 + 自定义宽高，自定义项放在选项列表末尾而不是单独一行
    if (controlKind(control) === "resolution") {
      // 视频不再提供 2K 档位：移除 K 预设，改由下方自定义宽高（折算为 P 值）输入
      const resolutionOpts = mediaType === "video"
        ? opts.filter((item) => !/^\d+(?:\.\d+)?k$/i.test(item))
        : opts;
      const tierStyle = resolutionOpts.length > 0 && resolutionOpts.every((item) => /^\d+(?:\.\d+)?k$/i.test(item));
      const rawValue = typeof value === "string" ? value : "";
      const tierBase = (option: string): number => {
        const known = IMAGE_SIZE_TIERS.find((tier) => tier.id.toLowerCase() === option.toLowerCase());
        if (known) {
          return known.base;
        }
        const numeric = Number(option.replace(/[^\d.]/g, ""));
        return Number.isFinite(numeric) && numeric > 0 ? numeric * 1024 : 1024;
      };
      // 当前值折算成尺寸：k 档按长边基准，P 值按短边基准
      const currentBase = rawValue
        ? (/^\d+(?:\.\d+)?k$/i.test(rawValue)
          ? Math.round(tierBase(rawValue) / (mediaType === "video" ? 2 : 1))
          : Number(rawValue.replace(/[^\d]/g, "")) || (mediaType === "video" ? 720 : 1024))
        : (mediaType === "video" ? 720 : 1024);
      const dims = mediaType === "video"
        ? videoSizeForHeight(currentBase, currentRatio)
        : imageSizeForTier(currentBase, currentRatio);
      const applySize = (width: number, heightValue: number) => {
        let next = options;
        const segments = control.path.split(".").map((item) => item.trim()).filter(Boolean);
        // 自定义宽高折算回档位：视频按短边 P 值，图片按长边就近 1K / 2K / 4K
        const target = mediaType === "video" ? Math.min(width, heightValue) : Math.max(width, heightValue);
        const tier = IMAGE_SIZE_TIERS.reduce(
          (best, item) => (Math.abs(item.base - target) < Math.abs(best.base - target) ? item : best),
          IMAGE_SIZE_TIERS[0],
        );
        const matched = resolutionOpts.find((option) => option.trim().toLowerCase() === tier.id.toLowerCase());
        next = setOptionAtPath(next, segments, mediaType === "video" ? `${Math.round(target)}p` : matched ?? `${Math.round(target)}`);
        if (ratioControl) {
          next = setOptionAtPath(next, ratioControl.path.split(".").map((item) => item.trim()), ratioLabel(width, heightValue));
        }
        if (mediaType === "video") {
          // OpenAI 兼容视频协议：720p 走 resolution_name，像素尺寸走 size，两者同步更新
          next = setOptionAtPath(next, ["size"], `${Math.round(width)}x${Math.round(heightValue)}`);
        }
        onOptionsChange(next);
      };
      const selectOption = (option: string) => {
        let next = setOptionAtPath(options, control.path.split(".").map((item) => item.trim()), option);
        if (mediaType === "video") {
          const base = tierStyle
            ? Math.round(tierBase(option) / 2)
            : Number(option.replace(/[^\d]/g, "")) || 720;
          const nextDims = videoSizeForHeight(base, currentRatio);
          next = setOptionAtPath(next, ["size"], `${nextDims.width}x${nextDims.height}`);
        }
        onOptionsChange(next);
      };
      return (
        <div key={control.path} className="space-y-1 px-0.5 py-0.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-foreground/85" title={control.path}>{paramLabel(control)}</span>
            <div className="flex shrink-0 items-center gap-1">
              <span className="text-[10px] tabular-nums text-muted-foreground">{dims.width} × {dims.height}</span>
              <ParamResetButton visible={controlValue !== undefined} onReset={() => update(control.path, undefined)} />
            </div>
          </div>
          <div className="rounded-xl bg-muted p-1 ring-1 ring-inset ring-border/50">
            <div className={cn("grid gap-1", resolutionOpts.length <= 3 ? "grid-cols-3" : resolutionOpts.length === 4 ? "grid-cols-4" : "grid-cols-6")}>
              {resolutionOpts.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "truncate rounded-lg px-1 py-1.5 text-[10px] transition-colors",
                    rawValue.toLowerCase() === option.toLowerCase()
                      ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/60"
                      : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                  )}
                  onClick={() => selectOption(option)}
                  title={option}
                >
                  {optionValueLabel(option)}
                </button>
              ))}
            </div>
            {/* 自定义宽高作为分辨率选项列表的最后一项 */}
            <div className="mt-1 rounded-lg bg-background/75 p-1.5">
              <SizeInputs width={dims.width} height={dims.height} onApply={applySize} />
            </div>
          </div>
        </div>
      );
    }
    // 画面比例：图形示例 + 比例值，排版与底部常驻比例一致
    if (controlKind(control) === "ratio") {
      return (
        <div key={control.path} className="space-y-1 px-0.5 py-0.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-foreground/85" title={control.path}>{paramLabel(control)}</span>
            <div className="flex shrink-0 items-center gap-1">
              {controlValue ? <span className="max-w-[7rem] truncate text-[10px] text-muted-foreground">{optionValueLabel(controlValue)}</span> : null}
              <ParamResetButton visible={controlValue !== undefined} onReset={() => update(control.path, undefined)} />
            </div>
          </div>
          <div className="grid grid-cols-6 gap-1 rounded-xl bg-muted p-1">
            {opts.map((option) => (
              <button
                key={option}
                type="button"
                title={option}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg py-1.5 text-[10px] transition-colors",
                  controlValue === option
                    ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/60"
                    : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                )}
                onClick={() => update(control.path, option)}
              >
                <RatioGlyph value={option} />
                <span className="tabular-nums">{optionValueLabel(option)}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div key={control.path} className="space-y-1 px-0.5 py-0.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-foreground/85" title={control.path}>{paramLabel(control)}</span>
          <div className="flex shrink-0 items-center gap-1">
            {controlValue !== undefined ? (
              <span className="max-w-[9rem] truncate text-[10px] text-muted-foreground" title={controlValue}>{optionValueLabel(controlValue)}</span>
            ) : null}
            <ParamResetButton visible={controlValue !== undefined} onReset={() => update(control.path, undefined)} />
          </div>
        </div>
        {opts.length > 0 ? (
          <OptionPills
            options={opts}
            value={typeof value === "string" ? value : undefined}
            onChange={(next) => update(control.path, next)}
            columns={opts.length <= 3 ? 3 : opts.length === 4 ? 4 : 6}
          />
        ) : (
          <input
            className="h-7 w-full rounded-md bg-background/90 px-2 text-[11px] outline-none focus:ring-1 focus:ring-primary/40"
            value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
            placeholder={t("automatic")}
            onChange={(event) => {
              const next = event.target.value.trim();
              update(control.path, !next ? undefined : control.type === "number" ? Number(next) : next);
            }}
          />
        )}
      </div>
    );
  };

  const hasContent = others.length > 0 || showResultCount;
  return (
    <div className="space-y-2.5">
      {hasContent ? (
        <div className="space-y-2">
          {showResultCount ? (
            <div className="px-0.5">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[11px] text-foreground/85">{t("resultCount")}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{resultCount ?? 1}</span>
              </div>
              <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted p-1">
                {[1, 2, 3, 4].map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={cn(
                      "rounded-lg py-1.5 text-[10px] font-medium tabular-nums transition-colors",
                      (resultCount ?? 1) === count
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => onResultCountChange?.(count)}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-2">{regularControls.map(renderControl)}</div>
          {gifControls.length > 0 ? (
            <div className="mt-1.5 grid grid-cols-2 gap-2">{gifControls.map(renderControl)}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// 常见模型参数的本地化名称：未知参数回退为原始路径，避免把内部字段直接暴露给用户
const PARAM_LABELS: Record<string, string> = {
  quality: "质量",
  background: "背景",
  output_format: "输出格式",
  frame_count: "帧数",
  frame_duration_ms: "帧间隔",
  input_fidelity: "输入保真度",
  style: "风格",
  styles: "风格",
  seed: "随机种子",
  size: "尺寸",
  image_size: "分辨率",
  imagesize: "分辨率",
  aspect_ratio: "画面比例",
  aspectratio: "画面比例",
  ratio: "画面比例",
  resolution: "分辨率",
  resolution_name: "分辨率",
  mode: "模式",
  reference_mode: "参考模式",
  reference: "参考内容",
  ref_mode: "参考模式",
  duration: "时长",
  seconds: "时长",
  negative_prompt: "负向提示词",
  prompt_extend: "提示词扩写",
  watermark: "水印",
  steps: "步数",
  guidance_scale: "引导强度",
  camerafixed: "固定镜头",
  n: "数量",
  response_modalities: "响应模态",
  responsemodalities: "响应模态",
  response_format: "响应格式",
  responseformat: "响应格式",
  mime_type: "文件格式",
  mimetype: "文件格式",
  media_resolution: "分辨率",
  mediaresolution: "分辨率",
};

function paramLabel(control: ModelOptionControl): string {
  const key = control.path.split(".").pop()?.toLowerCase() ?? control.path;
  return PARAM_LABELS[key] ?? control.label?.trim() ?? key;
}

// 底部常驻参数按钮：展示当前选中值，点击展开该参数的独立面板
function ParamChip({ label, value, width = "w-64", hideLabel = false, children }: { label: string; value: string; width?: string; hideLabel?: boolean; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 max-w-[9rem] items-center gap-1 rounded-lg border border-border/60 bg-background/80 px-2.5 text-[11px] transition-colors hover:bg-accent"
        >
          {hideLabel ? null : <span className="shrink-0 text-muted-foreground">{label}</span>}
          <span className="min-w-0 truncate font-medium text-foreground">{value}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent data-canvas-ui="param-chip" align="start" side="top" sideOffset={10} className={cn("p-2.5", width)}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function OptionPills({ options, value, onChange, columns = 3 }: { options: string[]; value?: string; onChange: (next: string | undefined) => void; columns?: number }) {
  return (
    <div
      className={cn(
        // 压暗容器背景，选中项用白底 + 描边拉开对比
        "grid gap-1 rounded-xl bg-muted p-1 ring-1 ring-inset ring-border/50",
        columns === 3 ? "grid-cols-3" : columns === 4 ? "grid-cols-4" : "grid-cols-6",
      )}
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={cn(
            "truncate rounded-lg px-1 py-1.5 text-[10px] transition-colors",
            value === option
              ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/60"
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
          )}
          onClick={() => onChange(option)}
          title={option}
        >
          {optionValueLabel(option)}
        </button>
      ))}
    </div>
  );
}

// 宽高输入：本地草稿，失焦或回车提交，避免每次按键都触发联动重排
function SizeInputs({
  width,
  height,
  onApply,
}: {
  width?: number;
  height?: number;
  onApply: (width: number, height: number) => void;
}) {
  const t = useTranslations("canvas.nodeInspector");
  const [draftWidth, setDraftWidth] = React.useState(width ? String(width) : "");
  const [draftHeight, setDraftHeight] = React.useState(height ? String(height) : "");

  React.useEffect(() => {
    setDraftWidth(width ? String(width) : "");
  }, [width]);

  React.useEffect(() => {
    setDraftHeight(height ? String(height) : "");
  }, [height]);

  const commit = () => {
    const nextWidth = Number(draftWidth);
    const nextHeight = Number(draftHeight);
    if (Number.isFinite(nextWidth) && Number.isFinite(nextHeight) && nextWidth > 0 && nextHeight > 0) {
      onApply(Math.round(nextWidth), Math.round(nextHeight));
    }
  };

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <input
        aria-label={t("width")}
        type="number"
        min={16}
        max={8192}
        value={draftWidth}
        placeholder={t("width")}
        className="h-7 w-16 rounded-md bg-background/90 px-2 text-[11px] tabular-nums outline-none ring-1 ring-border/50 focus:ring-1 focus:ring-primary/40"
        onChange={(event) => setDraftWidth(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <span className="text-[10px] text-muted-foreground">×</span>
      <input
        aria-label={t("height")}
        type="number"
        min={16}
        max={8192}
        value={draftHeight}
        placeholder={t("height")}
        className="h-7 w-16 rounded-md bg-background/90 px-2 text-[11px] tabular-nums outline-none ring-1 ring-border/50 focus:ring-1 focus:ring-primary/40"
        onChange={(event) => setDraftHeight(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <button
        type="button"
        className="ml-auto rounded-lg bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
        onClick={commit}
      >
        {t("apply")}
      </button>
    </div>
  );
}

function DurationSlider({ seconds, onChange }: { seconds: number; onChange: (next: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={30}
          step={1}
          value={seconds}
          aria-label="时长"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-foreground/15 accent-foreground"
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <div className="mt-1 flex justify-between text-[9px] tabular-nums text-muted-foreground/70">
          {[0, 5, 10, 15, 20, 25, 30].map((tick) => <span key={tick}>{tick}</span>)}
        </div>
      </div>
      <label className="flex h-9 w-20 shrink-0 items-center gap-1 rounded-lg bg-muted/85 px-2 focus-within:ring-1 focus-within:ring-primary/40">
        <input
          type="number"
          min={0}
          max={30}
          value={seconds}
          className="min-w-0 flex-1 bg-transparent text-center text-sm tabular-nums outline-none"
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="text-[11px] text-muted-foreground">S</span>
      </label>
    </div>
  );
}

// 自定义宽高比输入：确认后按当前分辨率档位重新组合尺寸
function CustomAspectInputs({ value, onApply }: { value: string; onApply: (ratio: string) => void }) {
  const t = useTranslations("canvas.nodeInspector");
  const parsed = parseRatio(value) ?? { width: 1, height: 1 };
  const [width, setWidth] = React.useState(String(parsed.width));
  const [height, setHeight] = React.useState(String(parsed.height));

  React.useEffect(() => {
    const next = parseRatio(value);
    if (next) {
      setWidth(String(next.width));
      setHeight(String(next.height));
    }
  }, [value]);

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <input
        type="number"
        min={1}
        max={99}
        value={width}
        className="h-7 w-14 rounded-md bg-muted/60 px-2 text-center text-[11px] tabular-nums outline-none focus:ring-1 focus:ring-primary/40"
        onChange={(event) => setWidth(event.target.value)}
      />
      <span className="text-[11px] text-muted-foreground">:</span>
      <input
        type="number"
        min={1}
        max={99}
        value={height}
        className="h-7 w-14 rounded-md bg-muted/60 px-2 text-center text-[11px] tabular-nums outline-none focus:ring-1 focus:ring-primary/40"
        onChange={(event) => setHeight(event.target.value)}
      />
      <button
        type="button"
        className="ml-auto rounded-lg bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
        onClick={() => onApply(`${Number(width) || 1}:${Number(height) || 1}`)}
      >
        {t("apply")}
      </button>
    </div>
  );
}

// 清理模型输出：去掉代码块围栏、常见前缀与包裹引号，只保留提示词正文
function sanitizeOptimizedPrompt(text: string): string {
  const value = (text ?? "")
    .replace(/```[a-zA-Z-]*\s*/g, "")
    .replace(/```/g, "")
    .trim()
    .replace(/^(?:优化后的?提示词|提示词|prompt)\s*[:：]\s*/i, "")
    .trim();
  return value.replace(/^["'“”「」]+|["'“”「」]+$/g, "").trim();
}

function createRunID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
}

export function CanvasNodeInspector({
  node,
  nodes,
  edges,
  models,
  left = 0,
  top = 0,
  width,
  inline = false,
  handlers,
}: {
  node: GenerateGraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  models: CanvasModelOption[];
  left?: number;
  top?: number;
  width?: number;
  // 内联模式：用于移动端底部对话框，不悬浮定位，宽度跟随容器
  inline?: boolean;
  handlers: CanvasNodeInspectorHandlers;
}) {
  const t = useTranslations("canvas.nodeInspector");
  const { accessToken } = useAuthSession();
  const mediaType = node.mediaType ?? "image";
  const isVideo = mediaType === "video";
  // 节点已有运行中的输出任务时禁止重复触发，避免重复计费与并发冲突
  const isRunning = React.useMemo(
    () => nodes.some(
      (item) => item.kind === "output" && item.sourceGenerateID === node.id && item.status === "running",
    ),
    [node.id, nodes],
  );
  const candidateModels = React.useMemo(
    () => models.filter((model) => model.kinds.includes("video_gen") === isVideo),
    [models, isVideo],
  );
  const model = React.useMemo(
    () => candidateModels.find((item) =>
      (node.modelScope === "user"
        ? item.modelScope === "user" && item.userModelID === node.userModelID
        : (item.modelScope ?? "platform") === (node.modelScope ?? "platform"))
      && item.platformModelName === node.model)
      ?? (node.model ? candidateModels.find((item) => item.platformModelName === node.model) : null)
      ?? null,
    [candidateModels, node.model, node.modelScope, node.userModelID],
  );
  // 素材类型解析：按 fileID 找到画布中的素材节点 / 产物，用于发送与优化时的序号编号
  const resolveAssetKind = React.useCallback((fileID: string): CanvasPromptAssetKind | null => {
    const owner = nodes.find((item) =>
      ((item.kind === "image" || item.kind === "media") && item.reference?.fileID === fileID)
      || (item.kind === "output" && item.fileID === fileID));
    if (!owner) {
      return null;
    }
    if (owner.kind === "image" || owner.kind === "media") {
      return canvasAssetKind(owner.reference?.mimeType, owner.reference?.fileName);
    }
    return owner.kind === "output" ? canvasAssetKind(owner.mimeType, owner.fileName) : null;
  }, [nodes]);
  const edgeAssets = React.useMemo(() => edgeAssetsForNode(node.id, nodes, edges), [edges, node.id, nodes]);
  // 画布上已有素材的预览地址：对话框内引用素材也据此显示缩略图
  const previewByFileID = React.useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const item of nodes) {
      if (item.kind === "image" || item.kind === "media") {
        if (item.reference) map.set(item.reference.fileID, item.previewURL);
      } else if (item.kind === "output" && item.status === "done" && item.fileID) {
        map.set(item.fileID, item.objectURL);
      }
    }
    return map;
  }, [nodes]);
  const localAssets = React.useMemo<AssetChipEntry[]>(() => (node.promptAssets ?? []).map((reference) => ({
    reference,
    kind: canvasAssetKind(reference.mimeType, reference.fileName),
    previewURL: previewByFileID.get(reference.fileID),
    sourceNodeID: node.id,
    local: true,
  })), [node.id, node.promptAssets, previewByFileID]);
  const allAssets = React.useMemo<AssetChipEntry[]>(() => {
    const seen = new Set<string>();
    const list: AssetChipEntry[] = [];
    for (const entry of [...edgeAssets, ...localAssets]) {
      if (seen.has(entry.reference.fileID)) continue;
      seen.add(entry.reference.fileID);
      list.push(entry);
    }
    return list;
  }, [edgeAssets, localAssets]);
  const libraryAssets = React.useMemo<CanvasAssetEntry[]>(() => {
    const seen = new Set(allAssets.map((item) => item.reference.fileID));
    const list: CanvasAssetEntry[] = [...allAssets];
    for (const item of nodes) {
      const reference = item.kind === "image" || item.kind === "media"
        ? item.reference
        : item.kind === "output" && item.status === "done" && item.fileID
          ? { fileID: item.fileID, fileName: item.fileName ?? "媒体", mimeType: item.mimeType ?? "", sizeBytes: item.sizeBytes ?? 0 }
          : null;
      if (!reference || seen.has(reference.fileID)) continue;
      seen.add(reference.fileID);
      list.push({
        reference,
        kind: canvasAssetKind(reference.mimeType, reference.fileName),
        previewURL: nodePreviewURL(item),
        sourceNodeID: item.id,
      });
    }
    return list;
  }, [allAssets, nodes]);

  const prompt = node.prompt ?? "";
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [paramsOpen, setParamsOpen] = React.useState(false);
  const [optimizing, setOptimizing] = React.useState(false);
  const editorRef = React.useRef<PromptEditorHandle | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const mentionListRef = React.useRef<HTMLDivElement | null>(null);
  const promptBoxRef = React.useRef<HTMLDivElement | null>(null);
  // @ 列表改为挂到 body 上，避免被对话框的 overflow 裁切；位置跟随提示词框实时测量
  const [mentionFrame, setMentionFrame] = React.useState<{ style: React.CSSProperties; maxHeight: number } | null>(null);

  const measureMentionFrame = React.useCallback(() => {
    const box = promptBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const width = Math.min(Math.max(rect.width * 0.42, 208), 264, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(rect.left, margin), Math.max(window.innerWidth - width - margin, margin));
    const spaceAbove = rect.top - gap - margin;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const placeBelow = spaceAbove < 220 && spaceBelow > spaceAbove;
    const maxHeight = Math.max(Math.min(placeBelow ? spaceBelow : spaceAbove, 320), 120);
    setMentionFrame({
      style: placeBelow
        ? { top: rect.bottom + gap, left, width, maxHeight }
        : { bottom: window.innerHeight - rect.top + gap, left, width, maxHeight },
      maxHeight,
    });
  }, []);

  // 面板打开期间跟随提示词框尺寸、窗口变化与画布滚动重新定位
  React.useEffect(() => {
    if (!mentionOpen) {
      setMentionFrame(null);
      return;
    }
    measureMentionFrame();
    const box = promptBoxRef.current;
    const observer = box ? new ResizeObserver(() => measureMentionFrame()) : null;
    if (box && observer) observer.observe(box);
    window.addEventListener("resize", measureMentionFrame);
    window.addEventListener("scroll", measureMentionFrame, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureMentionFrame);
      window.removeEventListener("scroll", measureMentionFrame, true);
    };
  }, [mentionOpen, measureMentionFrame]);

  // 素材选择面板：点击面板与编辑器之外自动收起，避免常驻遮挡
  React.useEffect(() => {
    if (!mentionOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (mentionListRef.current && target instanceof Node && mentionListRef.current.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest("[contenteditable='true']")) {
        return;
      }
      setMentionOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMentionOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mentionOpen]);

  // 添加素材：同步在节点图中创建/复用素材节点并连线，再在光标处插入引用标记
  const attachAsset = (asset: CanvasAssetEntry) => {
    handlers.onAttachAsset(node.id, asset.reference, asset.kind, asset.previewURL);
    editorRef.current?.insertAsset(asset);
    setMentionOpen(false);
    setLibraryOpen(false);
  };

  const removeAsset = (entry: AssetChipEntry) => {
    if (entry.edgeID) {
      handlers.onRemoveEdge(entry.edgeID);
      // 断开连线的同时移除提示词中的引用标记，保持素材条与提示词一致
      handlers.onUpdateNode(node.id, { prompt: removePromptToken(node.prompt ?? "", entry.reference.fileID) });
      return;
    }
    handlers.onUpdateNode(node.id, {
      promptAssets: (node.promptAssets ?? []).filter((item) => item.fileID !== entry.reference.fileID),
      // 同步移除提示词中的引用标记，避免删除素材后仍被解析为参考
      prompt: removePromptToken(node.prompt ?? "", entry.reference.fileID),
    });
  };

  const handleUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const uploaded = await handlers.uploadReferenceFile(file);
    if (!uploaded) return;
    const reference: CanvasNodeReference = {
      fileID: uploaded.fileID,
      fileName: uploaded.fileName,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
    };
    const asset: CanvasAssetEntry = {
      reference,
      kind: canvasAssetKind(reference.mimeType, reference.fileName),
      previewURL: uploaded.previewURL,
      sourceNodeID: node.id,
    };
    handlers.onAttachAsset(node.id, reference, asset.kind, uploaded.previewURL);
    editorRef.current?.insertAsset(asset);
    setLibraryOpen(false);
  };

  // 提示词优化：使用配置中选择的文本模型重写提示词；未配置模型时跳到配置面板提示选择
  const optimize = async () => {
    if (!prompt.trim() || optimizing) return;
    const config = loadPromptEnhancement();
    if (!config.model) {
      requestPromptEnhancementSettings();
      toast.warning(t("optimizeModelRequired"));
      return;
    }
    if (!accessToken) {
      toast.error(t("optimizeFailed"));
      return;
    }
    setOptimizing(true);
    try {
      const guidance = (isVideo ? config.video : config.image).trim();
      // 素材按「图1 / 视频1」序号引用：模型看不到文件名，只能按序号保留引用
      const markers = promptAssetTokens(prompt, resolveAssetKind).map((token) => `@${token.marker}`);
      const instruction = [
        `你是专业的${isVideo ? "视频" : "图片"}生成提示词优化助手，请把下面的提示词改写得更具体、专业、可直接用于生成模型。`,
        "要求：保持原始意图、主体和语言不变；补充构图、镜头、光线、材质、色彩与氛围等必要细节；不要添加无关内容；不要解释，不要使用引号或代码块，只输出一行优化后的提示词。",
        markers.length > 0
          ? `提示词中的 ${markers.join("、")} 是素材引用标记，必须原样保留，不要改写、删除或改动序号。`
          : "",
        guidance ? `额外要求：${guidance}。` : "",
        `原提示词：${promptForModelWithAssets(prompt, resolveAssetKind)}`,
      ].filter(Boolean).join("\n");
      let rewritten = "";
      const completed = await streamTemporaryChatMessage(accessToken, {
        sessionID: createRunID("canvas-opt"),
        clientRunID: createRunID("canvas-opt"),
        model: config.model,
        messages: [{ role: "user", content: instruction }],
        stream: true,
      }, {
        onTextSnapshot: (snapshot) => {
          rewritten = snapshot;
        },
      });
      const next = sanitizeOptimizedPrompt(rewritten || completed?.assistantMessage?.content || "");
      if (!next) {
        toast.error(t("optimizeFailed"));
        return;
      }
      handlers.onUpdateNode(node.id, { prompt: restorePromptAssetTokens(prompt, next, resolveAssetKind).slice(0, 20000) });
    } catch {
      toast.error(t("optimizeFailed"));
    } finally {
      setOptimizing(false);
    }
  };

  // 底部常驻参数：图片 = 分辨率 + 宽高比 + 数量；视频 = 时长 + 参考模式，其余进入参数面板
  const controls = React.useMemo(() => resolveCanvasMediaControls(model, mediaType), [mediaType, model]);
  // 只有选项确实是宽高比格式时才算画面比例参数，避免把响应模态等枚举误当成比例
  const ratioControl = controls.find(
    (control) =>
      controlKind(control) === "ratio"
      && (control.options ?? []).some((option) => /^\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?$/.test(option.trim())),
  );
  const sizeControl = controls.find((control) => controlKind(control) === "size");
  const resolutionControl = controls.find((control) => controlKind(control) === "resolution");
  const durationControl = controls.find((control) => controlKind(control) === "duration");
  const modeControl = controls.find((control) => controlKind(control) === "mode");
  const controlValue = (control: ModelOptionControl | undefined) => {
    if (!control) return undefined;
    const value = getOptionAtPath(node.options, control.path.split("."));
    return value === undefined || value === null || value === "" ? undefined : String(value);
  };
  const updateOption = (control: ModelOptionControl | undefined, value: string | undefined) => {
    if (!control) return;
    const segments = control.path.split(".").map((item) => item.trim()).filter(Boolean);
    handlers.onUpdateNode(node.id, {
      options: value === undefined ? deleteOptionAtPath(node.options, segments) : setOptionAtPath(node.options, segments, value),
    });
  };
  const durationSeconds = durationControl
    ? Number(getOptionAtPath(node.options, durationControl.path.split("."))) || 5
    : 5;
  // 宽高比：优先取比例参数；只有像素尺寸时按数值比例就近匹配预设比例，
  // 避免自定义尺寸（如 1024x439）反推出 "1024:439" 导致选中态丢失、跳到第一项
  const currentSize = sizeControl ? parseSizeValue(controlValue(sizeControl) ?? "") : null;
  const baseAspectOptions = ratioControl?.options?.length ? ratioControl.options : DEFAULT_ASPECT_RATIOS;
  const closestAspect = (() => {
    if (!currentSize) {
      return "1:1";
    }
    const ratio = currentSize.width / currentSize.height;
    let best = baseAspectOptions[0] ?? "1:1";
    let bestScore = Number.POSITIVE_INFINITY;
    for (const option of baseAspectOptions) {
      const parsed = parseRatio(option);
      if (!parsed) continue;
      const score = Math.abs(Math.log(ratio / (parsed.width / parsed.height)));
      if (score < bestScore) {
        bestScore = score;
        best = option;
      }
    }
    return best;
  })();
  const aspectValue = controlValue(ratioControl) ?? closestAspect;
  const aspectOptions = baseAspectOptions;
  // 当前分辨率档位：有像素尺寸按长边就近匹配，只有档位参数时直接取所选档位
  const tierBase = currentSize
    ? IMAGE_SIZE_TIERS.reduce((best, tier) => Math.abs(tier.base - Math.max(currentSize.width, currentSize.height)) < Math.abs(best.base - Math.max(currentSize.width, currentSize.height)) ? tier : best, IMAGE_SIZE_TIERS[0]).base
    : resolutionControl
      ? IMAGE_SIZE_TIERS.find((tier) => tier.id.toLowerCase() === (controlValue(resolutionControl) ?? "").toLowerCase())?.base ?? IMAGE_SIZE_TIERS[0].base
      : IMAGE_SIZE_TIERS[0].base;
  const tierLabel = IMAGE_SIZE_TIERS.find((tier) => tier.base === tierBase)?.id ?? "1K";
  // 图片尺寸统一入口：宽高为唯一事实来源，按控件能力同步 size / 画面比例 / 分辨率档位
  const applyImageSize = (width: number, height: number, ratioOverride?: string) => {
    const nextWidth = Math.max(16, Math.round(width));
    const nextHeight = Math.max(16, Math.round(height));
    let next = node.options;
    if (sizeControl) {
      // OpenAI / image_edits_json：size 就是像素组合，1K/2K/4K 只是预设
      next = setOptionAtPath(next, sizeControl.path.split(".").map((item) => item.trim()), `${nextWidth}x${nextHeight}`);
    }
    if (ratioControl) {
      // 选比例时保留用户选择的比例值，只有手动输入宽高才按像素反推最简比例
      next = setOptionAtPath(
        next,
        ratioControl.path.split(".").map((item) => item.trim()),
        ratioOverride ?? ratioLabel(nextWidth, nextHeight),
      );
    }
    if (!sizeControl && resolutionControl) {
      // Gemini 等只接收档位：自定义宽高按长边折算到最近的 1K/2K/4K
      const target = Math.max(nextWidth, nextHeight);
      const tier = IMAGE_SIZE_TIERS.reduce(
        (best, item) => (Math.abs(item.base - target) < Math.abs(best.base - target) ? item : best),
        IMAGE_SIZE_TIERS[0],
      );
      const matched = (resolutionControl.options ?? []).find(
        (option) => option.trim().toLowerCase() === tier.id.toLowerCase(),
      );
      if (matched) {
        next = setOptionAtPath(next, resolutionControl.path.split(".").map((item) => item.trim()), matched);
      }
    }
    handlers.onUpdateNode(node.id, { options: next });
  };
  // 选择分辨率档位 / 宽高比：一次合并写入，避免连续更新互相覆盖导致选中态跳到第一项
  const applyImageAspect = (base: number, ratio: string) => {
    const { width, height } = imageSizeForTier(base, ratio);
    applyImageSize(width, height, ratio);
  };
  // 参数面板：去掉底部已常驻的参数，避免重复展示
  const inlineRoles = mediaType === "video"
    ? new Set<ParamControlKind>(["duration", "mode"])
    : new Set<ParamControlKind>(["resolution", "size", "ratio"]);
  const moreControls = controls.filter((control) => !inlineRoles.has(controlKind(control)));
  // 参考模式默认「全能参考」：未显式选择时自动写入模型支持的对应选项，避免落到模型默认值
  const defaultModeOption = React.useMemo(() => {
    const options = modeControl?.options ?? [];
    return options.find((option) => optionValueLabel(option) === "全能参考模式");
  }, [modeControl]);
  React.useEffect(() => {
    if (!modeControl || !defaultModeOption) {
      return;
    }
    const path = modeControl.path.split(".").map((item) => item.trim()).filter(Boolean);
    const current = getOptionAtPath(node.options, path);
    if (current === undefined || current === null || current === "") {
      handlers.onUpdateNode(node.id, { options: setOptionAtPath(node.options, path, defaultModeOption) });
    }
  }, [defaultModeOption, handlers, modeControl, node.id, node.options]);
  // 「更多参数」按钮直接显示面板内已选值（如 16:9-720p-1），未选择时回退为「参数」
  const paramsSummary = React.useMemo(() => {
    const outputFormatControl = moreControls.find((control) => controlKind(control) === "outputFormat");
    const outputFormatValue = outputFormatControl
      ? String(getOptionAtPath(node.options, outputFormatControl.path.split(".")) ?? "").toLowerCase()
      : "";
    const parts: string[] = [];
    for (const control of moreControls) {
      // GIF 专属参数在未启用 GIF 时不参与摘要
      if (GIF_ONLY_VALUE_KEYS.has(controlPathKey(control)) && outputFormatValue !== "gif") {
        continue;
      }
      const value = getOptionAtPath(node.options, control.path.split("."));
      if (value === undefined || value === null || value === "") {
        continue;
      }
      parts.push(optionValueLabel(String(value)));
    }
    // 图片生成数量已移入参数面板，摘要同样带上
    if (mediaType === "image") {
      parts.push(String(node.resultCount));
    }
    // 用明显的圆点分隔各项，便于一眼区分多个参数值
    return parts.join(" · ");
  }, [mediaType, moreControls, node.options, node.resultCount]);

  return (
    <div
      data-canvas-ui="node-inspector"
      className={cn(
        "flex flex-col",
        inline
          ? "pointer-events-auto w-full overflow-hidden rounded-t-2xl border-t border-border/60 bg-background/98 shadow-[0_-18px_50px_-30px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
          : "pointer-events-auto absolute z-30 overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-[0_32px_90px_-30px_rgba(0,0,0,0.55)] backdrop-blur-2xl",
      )}
      style={inline ? undefined : { left, top, width, maxWidth: "calc(100vw - 24px)" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* 素材条：连入素材 + 对话框内引用素材 */}
      <div className="flex items-start gap-2 border-b border-border/50 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {allAssets.length === 0 ? <span className="text-[11px] text-muted-foreground">{t("assetsEmpty")}</span> : null}
          {allAssets.map((entry) => (
            <AssetChip key={`${entry.edgeID ?? entry.reference.fileID}`} entry={entry} onRemove={() => removeAsset(entry)} />
          ))}
          <Popover open={libraryOpen} onOpenChange={setLibraryOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-border/70 px-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <Plus className="size-3.5" strokeWidth={1.8} />
                {t("addAsset")}
              </button>
            </PopoverTrigger>
            <PopoverContent data-canvas-ui="asset-library" align="start" side="bottom" className="w-72 p-1.5">
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent" onClick={() => fileInputRef.current?.click()}>
                <Upload className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
                {t("uploadFile")}
              </button>
              <div className="my-1 h-px bg-border/60" />
              <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("fromLibrary")}</p>
              <AssetPickerList assets={libraryAssets} onPick={attachAsset} emptyLabel={t("libraryEmpty")} />
            </PopoverContent>
          </Popover>
        </div>
        <button
          type="button"
          aria-label={t("close")}
          title={t("close")}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={handlers.onClose}
        >
          <X className="size-4" strokeWidth={1.8} />
        </button>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" className="hidden" onChange={(event) => { void handleUpload(event.target.files); event.currentTarget.value = ""; }} />

      {/* 提示词：编辑态与展示态一致，素材标记始终渲染为小图 / 音频气泡 */}
      <div className="relative px-3 pt-2.5">
        <div ref={promptBoxRef} className="relative rounded-xl border border-border/50 bg-muted/25 px-3 py-2.5 focus-within:ring-1 focus-within:ring-primary/30">
          {!prompt.trim() ? (
            <span className="pointer-events-none absolute left-3 top-2.5 text-[13px] leading-6 text-muted-foreground/60">{t("promptPlaceholder")}</span>
          ) : null}
          <PromptEditor
            ref={editorRef}
            value={prompt}
            assets={allAssets}
            onChange={(next) => handlers.onUpdateNode(node.id, { prompt: next.slice(0, 20000) })}
            onMention={() => setMentionOpen(true)}
          />
        </div>

        {/* @ 素材选择：选中后插入引用标记，同时在节点图中创建/复用素材节点并连线；挂到 body 上避免被对话框裁切 */}
        {mentionOpen && mentionFrame && typeof document !== "undefined"
          ? createPortal(
              <div
                ref={mentionListRef}
                data-canvas-ui="mention-list"
                style={mentionFrame.style}
                className="fixed z-[80] flex flex-col overflow-hidden rounded-xl border border-border/60 bg-background/98 shadow-xl backdrop-blur-xl"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="flex shrink-0 items-center justify-between px-2.5 pt-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("mentionTitle")}</p>
                  <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setMentionOpen(false)}>{t("close")}</button>
                </div>
                <AssetPickerList assets={libraryAssets} onPick={attachAsset} emptyLabel={t("libraryEmpty")} maxHeight={mentionFrame.maxHeight - 30} />
              </div>,
              document.body,
            )
          : null}

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                editorRef.current?.focus();
                setMentionOpen((open) => !open);
              }}
            >
              <span className="text-sm leading-none">@</span>
              {t("mention")}
            </button>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
              disabled={optimizing || !prompt.trim()}
              onClick={optimize}
            >
              {optimizing ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} /> : <Sparkles className="size-3.5" strokeWidth={1.8} />}
              {t("optimize")}
            </button>
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground/70">{prompt.length} / 20000</span>
        </div>
      </div>

      {/* 参数与运行：模型与发送固定，中间参数在窄宽度下横向滚动，保证模型名完整显示 */}
      <div className="mt-2 flex flex-nowrap items-center gap-1.5 border-t border-border/50 px-3 py-2.5">
        <CanvasModelSelect
          models={candidateModels}
          selectedModel={model}
          onSelect={(nextModel) => {
            handlers.onUpdateNode(node.id, {
              model: nextModel.platformModelName,
              modelScope: nextModel.modelScope === "user" ? "user" : "platform",
              userModelID: nextModel.modelScope === "user" ? nextModel.userModelID : undefined,
              mediaType: nextModel.kinds.includes("video_gen") ? "video" : "image",
            });
          }}
          className="h-9 min-w-[9rem] max-w-[15rem] flex-1 justify-between rounded-lg border-border/60 bg-background/80"
        />
        <div className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto">
        {mediaType === "image" && (sizeControl || resolutionControl) ? (
          <ParamChip label={t("resolution")} value={sizeControl ? tierLabel : controlValue(resolutionControl) ?? t("automatic")}>
            <div className="rounded-xl bg-muted p-1 ring-1 ring-inset ring-border/50">
              <div className="grid grid-cols-3 gap-1">
                {IMAGE_SIZE_TIERS.map((tier) => {
                  const activeTier = resolutionControl
                    ? (controlValue(resolutionControl) ?? "").toUpperCase()
                    : tierLabel;
                  return (
                    <button
                      key={tier.id}
                      type="button"
                      className={cn(
                        "rounded-lg py-2 text-[11px] font-medium tabular-nums transition-colors",
                        activeTier === tier.id
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                          : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                      )}
                      onClick={() => applyImageAspect(tier.base, aspectValue)}
                    >
                      {tier.id}
                    </button>
                  );
                })}
              </div>
              {/* 自定义宽高作为分辨率选项列表的最后一项，不再单独成行 */}
              <div className="mt-1 rounded-lg bg-background/75 p-1.5">
                <SizeInputs
                  width={(currentSize ?? imageSizeForTier(tierBase, aspectValue)).width}
                  height={(currentSize ?? imageSizeForTier(tierBase, aspectValue)).height}
                  onApply={applyImageSize}
                />
              </div>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {sizeControl ? t("sizeHintImage") : t("sizeHintTier")}
            </p>
          </ParamChip>
        ) : null}
        {mediaType === "image" && (ratioControl || sizeControl) ? (
          <ParamChip label={t("aspectRatio")} value={aspectValue}>
            <div className="grid grid-cols-4 gap-1">
              {aspectOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn("flex flex-col items-center gap-1 rounded-lg py-2 text-[10px] transition-colors", aspectValue === option ? "bg-primary/10 text-foreground ring-1 ring-primary/30" : "text-muted-foreground hover:bg-accent")}
                  onClick={() => applyImageAspect(tierBase, option)}
                >
                  <RatioGlyph value={option} />
                  {option}
                </button>
              ))}
            </div>
            <CustomAspectInputs value={aspectValue} onApply={(ratio) => applyImageAspect(tierBase, ratio)} />
          </ParamChip>
        ) : null}
        {mediaType === "video" && durationControl ? (
          <ParamChip label={t("durationShort")} value={`${durationSeconds}s`} width="w-72">
            <DurationSlider
              seconds={durationSeconds}
              onChange={(next) => updateOption(durationControl, String(Math.max(0, Math.min(30, Math.round(next)))))}
            />
          </ParamChip>
        ) : null}
        {mediaType === "video" && modeControl ? (
          <ParamChip
            label={t("referenceMode")}
            hideLabel
            value={controlValue(modeControl) ? optionValueLabel(controlValue(modeControl) as string) : "全能参考模式"}
            width="w-48"
          >
            <div className="grid grid-cols-1 gap-1 rounded-xl bg-muted p-1 ring-1 ring-inset ring-border/50">
              {(modeControl.options ?? []).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "rounded-lg py-2 text-[11px] transition-colors",
                    controlValue(modeControl) === option
                      ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                      : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                  )}
                  onClick={() => updateOption(modeControl, option)}
                  title={option}
                >
                  {optionValueLabel(option)}
                </button>
              ))}
            </div>
          </ParamChip>
        ) : null}
        <Popover open={paramsOpen} onOpenChange={setParamsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex h-9 max-w-[9rem] items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate" title={paramsSummary || t("params")}>
                {paramsSummary || t("params")}
              </span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" strokeWidth={2} />
            </button>
          </PopoverTrigger>
          <PopoverContent data-canvas-ui="node-params" align="end" side="top" sideOffset={10} className="w-80 p-2.5">
            <NodeParamsPanel
              controls={moreControls}
              options={node.options}
              mediaType={mediaType}
              resultCount={node.resultCount}
              showResultCount={mediaType === "image"}
              onResultCountChange={(resultCount) => handlers.onUpdateNode(node.id, { resultCount })}
              onOptionsChange={(options) => handlers.onUpdateNode(node.id, { options })}
            />
          </PopoverContent>
        </Popover>
        </div>
        <button
          type="button"
          disabled={!model || isRunning}
          className={cn(
            "ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-primary-foreground shadow-sm transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
            isVideo ? "bg-violet-600 hover:bg-violet-600/90" : "bg-primary hover:bg-primary/90",
          )}
          onClick={() => handlers.onRunNode(node.id)}
        >
          {isRunning ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
          ) : isVideo ? (
            <Clapperboard className="size-3.5" strokeWidth={1.8} />
          ) : (
            <Check className="size-3.5" strokeWidth={2} />
          )}
          {isRunning ? t("running") : isVideo ? t("runVideo") : t("runImage")}
        </button>
      </div>
    </div>
  );
}
