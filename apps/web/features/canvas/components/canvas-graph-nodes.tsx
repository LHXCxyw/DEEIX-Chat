"use client";

import {
  AlertTriangle,
  ChevronDown,
  Clapperboard,
  Clock3,
  Copy,
  Download,
  ImageIcon,
  ImageOff,
  ImagePlus,
  Images,
  Maximize2,
  Paintbrush,
  Repeat2,
  RotateCw,
  Search,
  Square,
  TextCursorInput,
  Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { AssetNameBar, GraphNodeShell } from "@/features/canvas/components/canvas-graph-node-shell";
import { MediaGraphNodeView } from "@/features/canvas/components/canvas-media-node";
import { TimelineGraphNodeView, type TimelineAttachOption, type TimelineSourceInfo } from "@/features/canvas/components/canvas-timeline-node";
import { CanvasPromptExpandDialog } from "@/features/canvas/components/canvas-prompt-expand";
import { PromptTemplateLibrary } from "@/features/canvas/components/canvas-prompt-template-library";
import { CopyActionButton } from "@/shared/components/copy-action";
import type { CanvasReferenceImage } from "@/features/canvas/hooks/use-canvas-store";
import {
  type GraphPortID,
  graphModelDisplayName,
  graphNodePorts,
  isGraphPortCompatibleTarget,
} from "@/features/canvas/model/canvas-graph";
import {
  type CanvasMediaKind,
  type GenerateGraphNode,
  type GraphNode,
  type GraphNodeUpdate,
  graphNodeSize,
  type ImageGraphNode,
  type MediaGraphNode,
  type OutputGraphNode,
  PROMPT_MAX_LENGTH,
  type PromptGraphNode,
  type TimelineTrackKind,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

export type GraphNodeActionHandlers = {
  onUpdateNode: (nodeID: string, patch: GraphNodeUpdate) => void;
  // 参考图节点预览缺失时按 fileID 拉取（刷新恢复 / 跨节点拖入后触发）
  onEnsureNodePreview: (nodeID: string) => void;
  onRemoveNode: (nodeID: string) => void;
  onRunNode: (nodeID: string) => void;
  onCancelNode: (nodeID: string) => void;
  onRequeryNode: (nodeID: string) => void;
  // 输出节点任务重查：任务绑定随输出节点走，失败的视频输出节点自治回查上游结果
  onRequeryOutputNode: (nodeID: string) => void;
  // 输出节点产物保存重试（保存待重试时输出节点自治重新保存）
  onRetryOutputSave: (nodeID: string) => void;
  onPreviewNode: (node: OutputGraphNode) => void;
  // 合并节点的结果预览：图像与视频统一入口
  onPreviewResult: (node: OutputGraphNode) => void;
  onDownloadNode: (node: OutputGraphNode) => void;
  onEditNode: (node: OutputGraphNode) => void;
  onEditReferenceNode: (node: ImageGraphNode, mode?: "inpaint" | "crop" | "outpaint") => void;
  // 点击素材节点 / 视频结果：打开素材悬浮工具栏（模型选择 + 各类操作）
  onOpenAssetToolbar: (node: ImageGraphNode | MediaGraphNode | OutputGraphNode) => void;
  // 选中节点：点击生成结果时打开该生成节点的对话框
  onSelectNode: (nodeID: string) => void;
  // 时间线节点：按片段时间点分割、删除片段、导出拼接结果、接入新的视频来源
  onSplitTimelineSegment: (nodeID: string, segmentID: string, at: number, duration: number, timelineAt?: number) => void;
  // 在指定时间点切分所有跨越该点的片段（含整段素材的已知时长与时间线偏移）
  onSplitTimelineAt: (nodeID: string, at: number, layout: Record<string, { offset: number; duration: number }>) => void;
  onRemoveTimelineSegment: (nodeID: string, segmentID: string) => void;
  onExportTimeline: (nodeID: string) => void;
  onAttachTimelineSource: (timelineNodeID: string, sourceNodeID: string, track: TimelineTrackKind, trackID?: string) => void;
  // 时间线工具栏内的撤销 / 重做
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUseAsReference: (node: OutputGraphNode) => void;
  uploadReferenceFile: (file: File) => Promise<CanvasReferenceImage | null>;
};

// 跨节点图片拖拽：dataTransfer 携带已上传参考图的元数据（JSON），
// 供任意参考图节点的加载区接收（data-canvas-image-drop 会拦截节点拖拽）
export const CANVAS_IMAGE_DRAG_MIME = "application/deeix-canvas-image";

export type CanvasImageDragPayload = {
  fileID: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewURL?: string;
};

export function canvasImageDragPayload(event: React.DragEvent): CanvasImageDragPayload | null {
  const raw = event.dataTransfer.getData(CANVAS_IMAGE_DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasImageDragPayload> | null;
    if (parsed && typeof parsed.fileID === "string" && typeof parsed.fileName === "string" &&
      typeof parsed.mimeType === "string" && typeof parsed.sizeBytes === "number") {
      return {
        fileID: parsed.fileID,
        fileName: parsed.fileName,
        mimeType: parsed.mimeType,
        sizeBytes: parsed.sizeBytes,
        previewURL: typeof parsed.previewURL === "string" ? parsed.previewURL : undefined,
      };
    }
  } catch {
    // 非法载荷按无数据处理
  }
  return null;
}

// 指向当前节点的连线端口高亮：拖拽连线时提示可落点
function useCompatiblePort(
  node: GraphNode,
  connecting: { kind: string; port: GraphPortID; mediaKind?: CanvasMediaKind } | null,
): boolean {
  // 端口布局按媒体类型取（视频生成节点含参考视频 / 参考音频入端口）
  const mediaType = node.kind === "generate" || node.kind === "output" ? node.mediaType : undefined;
  return React.useMemo(() => {
    if (!connecting) {
      return false;
    }
    const ports = graphNodePorts(node.kind, mediaType);
    return ports.some(
      (port) =>
        port.direction === "in" &&
        isGraphPortCompatibleTarget(
          connecting.kind as GraphNode["kind"],
          node.kind,
          port.id,
          connecting.mediaKind,
        ),
    );
  }, [connecting, mediaType, node.kind]);
}

// ---------------------------------------------------------------------------
// 提示词节点：多行输入 + 模板库
// ---------------------------------------------------------------------------
function PromptGraphNodeView({
  node,
  selected,
  compatible,
  handlers,
}: {
  node: PromptGraphNode;
  selected: boolean;
  compatible: boolean;
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  // 全屏编辑：节点内输入框空间有限，长提示词需要更大的编辑区域
  const [expanded, setExpanded] = React.useState(false);
  const truncated = node.text.length > PROMPT_MAX_LENGTH ? node.text.slice(0, PROMPT_MAX_LENGTH) : node.text;
  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="prompt"
      title={t("nodeKindPrompt")}
      icon={<TextCursorInput className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
    >
      <div className="flex h-full flex-col gap-1.5 p-2.5">
        <textarea
          data-canvas-selectable
          value={truncated}
          onChange={(event) => handlers.onUpdateNode(node.id, { text: event.target.value })}
          placeholder={t("promptPlaceholder")}
          className="min-h-0 w-full flex-1 resize-none rounded-lg border border-border/50 bg-background/50 p-2 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
        />
        <div className="flex shrink-0 items-center justify-between gap-2">
          <PromptTemplateLibrary
            promptText={node.text}
            onApply={(text) => handlers.onUpdateNode(node.id, { text })}
          />
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {node.text.length} / {PROMPT_MAX_LENGTH.toLocaleString()}
          </span>
          <button
            type="button"
            data-canvas-selectable
            aria-label={t("promptExpandOpen")}
            title={t("promptExpandOpen")}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            <Maximize2 className="size-3.5" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <CanvasPromptExpandDialog
        open={expanded}
        title={t("promptExpandTitle")}
        value={node.text}
        placeholder={t("promptPlaceholder")}
        onChange={(text) => handlers.onUpdateNode(node.id, { text })}
        onClose={() => setExpanded(false)}
      />
    </GraphNodeShell>
  );
}

// ---------------------------------------------------------------------------
// 参考图节点：上传 / 粘贴图片作为生成输入
// ---------------------------------------------------------------------------
function ImageGraphNodeView({
  node,
  selected,
  compatible,
  handlers,
}: {
  node: ImageGraphNode;
  selected: boolean;
  compatible: boolean;
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const [dragOver, setDragOver] = React.useState(false);
  // 记录按下位置：拖动节点后不误触工具栏
  const pressRef = React.useRef<{ x: number; y: number } | null>(null);

  // 预览缺失（刷新恢复 / 跨节点拖入）时按 fileID 拉取
  React.useEffect(() => {
    if (node.reference && !node.previewURL && !node.previewLoading) {
      handlers.onEnsureNodePreview(node.id);
    }
  }, [handlers, node.id, node.previewLoading, node.previewURL, node.reference]);

  const handleFile = React.useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error(t("referenceNotImage"));
        return;
      }
      handlers.onUpdateNode(node.id, { uploading: true });
      const uploaded = await handlers.uploadReferenceFile(file);
      handlers.onUpdateNode(node.id, {
        reference: uploaded
          ? {
            fileID: uploaded.fileID,
            fileName: uploaded.fileName,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
          }
          : null,
        uploading: false,
        previewURL: uploaded?.previewURL,
      });
    },
    [handlers, node.id, t],
  );

  // 接收来自其他节点的图片资源（输出节点结果 / 参考图）
  const handlePayloadDrop = React.useCallback(
    (payload: CanvasImageDragPayload) => {
      handlers.onUpdateNode(node.id, {
        reference: {
          fileID: payload.fileID,
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          sizeBytes: payload.sizeBytes,
        },
        previewURL: payload.previewURL,
        previewLoading: !payload.previewURL,
        previewFailed: false,
        uploading: false,
      });
    },
    [handlers, node.id],
  );

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(CANVAS_IMAGE_DRAG_MIME) &&
        !Array.from(event.dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: React.DragEvent) => {
      const payload = canvasImageDragPayload(event);
      if (payload) {
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        handlePayloadDrop(payload);
        return;
      }
      const file = event.dataTransfer.files[0];
      if (file) {
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        void handleFile(file);
      }
    },
  };

  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="image"
      title={t("nodeKindImage")}
      icon={<ImageIcon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
      bare
    >
      <div className="flex size-full flex-col overflow-hidden rounded-xl">
        {node.reference ? (
          <>
          <div
            className={cn(
              "group/ref relative min-h-0 flex-1 overflow-hidden bg-muted/25 transition-colors",
              dragOver && "ring-2 ring-primary/40",
            )}
            role="button"
            tabIndex={0}
            aria-label={t("assetActions")}
            onPointerDown={(event) => {
              pressRef.current = { x: event.clientX, y: event.clientY };
            }}
            onClick={(event) => {
              event.stopPropagation();
              const press = pressRef.current;
              pressRef.current = null;
              if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
                return;
              }
              handlers.onOpenAssetToolbar(node);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                handlers.onOpenAssetToolbar(node);
              }
            }}
            {...dropProps}
          >
            {node.previewURL ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={node.reference.fileName}
                src={node.previewURL}
                className="size-full object-contain"
                draggable
                data-canvas-image-drop
                onDragStart={(event) => {
                  // 作为跨节点拖拽源：携带参考图元数据供其他节点接收
                  event.dataTransfer.setData(CANVAS_IMAGE_DRAG_MIME, JSON.stringify({
                    fileID: node.reference?.fileID,
                    fileName: node.reference?.fileName,
                    mimeType: node.reference?.mimeType,
                    sizeBytes: node.reference?.sizeBytes,
                    previewURL: node.previewURL,
                  }));
                  event.dataTransfer.effectAllowed = "copy";
                }}
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
                {node.previewFailed ? (
                  <>
                    <ImageOff className="size-5" strokeWidth={1.6} />
                    <p className="text-[11px]">{t("nodeImageLoadFailed")}</p>
                  </>
                ) : (
                  <>
                    <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
                    <p className="text-[11px]">{t("nodeLoadingImage")}</p>
                  </>
                )}
              </div>
            )}
            {/* 拖入其他节点图片时的高亮替换提示 */}
            {dragOver ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-primary/15 backdrop-blur-[1px]">
                <ImagePlus className="size-5 text-primary" strokeWidth={1.8} />
                <span className="rounded-full bg-background/85 px-2 py-0.5 text-[10px] font-medium text-foreground">
                  {t("imageNodeDropReplaceHint")}
                </span>
              </div>
            ) : null}
          </div>
          <AssetNameBar
            kind="image"
            name={node.reference.fileName}
            onRename={(next) => handlers.onUpdateNode(node.id, {
              reference: node.reference ? { ...node.reference, fileName: next } : null,
            })}
            className="shrink-0 pt-1"
          />
          </>
        ) : (
          <label
            data-canvas-selectable
            data-canvas-image-drop
            className={cn(
              "pointer-events-auto flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl bg-muted/20 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground",
              dragOver && "bg-primary/5 text-foreground ring-2 ring-primary/40",
            )}
            {...dropProps}
          >
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleFile(file);
                }
                event.currentTarget.value = "";
              }}
            />
            {node.uploading ? (
              <>
                <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
                <span className="px-4 text-center text-[11px] leading-relaxed">
                  {t("imageNodeUploading")}
                </span>
              </>
            ) : (
              <>
                <Upload className="size-5" strokeWidth={1.6} />
                <span className="px-4 text-center text-[11px] leading-relaxed">
                  {t("imageNodeUploadHint")}
                </span>
              </>
            )}
          </label>
        )}
      </div>
    </GraphNodeShell>
  );
}

// ---------------------------------------------------------------------------
// 生成节点：模型选择、提示词摘要、运行状态与结果预览（生成与输出合并为一张卡片）
// ---------------------------------------------------------------------------

// 错误原始响应：可折叠的脱敏上游详情（含 HTTP 状态与上游正文），附复制按钮便于用户反馈排障
function ErrorDetailPanel({ detail }: { detail: string }) {
  const t = useTranslations("canvas");
  const [open, setOpen] = React.useState(false);
  return (
    <div className="w-full">
      <div className="flex items-center justify-center gap-1">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} strokeWidth={1.8} />
          {t("nodeErrorRawResponse")}
        </button>
        <CopyActionButton
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 text-muted-foreground/80 hover:text-foreground"
          value={detail}
          aria-label={t("nodeCopyError")}
          title={t("nodeCopyError")}
          messages={{ copied: t("copyErrorSuccess"), failed: t("copyPromptFailed") }}
          copyIcon={<Copy className="size-3" strokeWidth={1.8} />}
        />
      </div>
      {open ? (
        <pre
          data-canvas-selectable
          className="mt-1 max-h-28 w-full overflow-auto rounded-md bg-muted/60 p-1.5 text-left font-mono text-[9px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground select-text"
        >
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

function GenerateGraphNodeView({
  node,
  selected,
  compatible,
  resultNode,
  handlers,
}: {
  node: GenerateGraphNode;
  selected: boolean;
  compatible: boolean;
  // 已合并进卡片的输出子节点：结果、运行态与失败信息都从它读取
  resultNode: OutputGraphNode | null;
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const mediaType = node.mediaType ?? "image";
  const isVideo = mediaType === "video";
  const running = resultNode?.status === "running"
    || node.runStatus === "pending"
    || node.runStatus === "streaming";
  const isDone = resultNode?.status === "done";
  const errorMessage = resultNode?.status === "error" ? resultNode.errorMessage : node.errorMessage;
  const statusLabel = resultNode?.statusLabel ?? node.statusLabel;
  const progress = resultNode?.progress ?? node.progress;
  const streamingPreview = resultNode?.status === "running" ? resultNode.previewURL : node.previewURL;
  const cancelTargetID = resultNode?.status === "running" ? resultNode.runID ?? resultNode.sourceGenerateID ?? null : node.id;
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  // 记录按下位置：结果区允许拖动节点，拖动后不误触工具栏
  const pressRef = React.useRef<{ x: number; y: number } | null>(null);

  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="generate"
      mediaType={mediaType}
      title={isVideo ? t("nodeKindGenerateVideo") : t("nodeKindGenerate")}
      icon={isVideo
        ? <Clapperboard className="size-3.5 shrink-0 text-violet-500" strokeWidth={1.8} />
        : <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      variant={isVideo ? "video" : undefined}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
      bare
    >
      <div className="relative size-full">
        {/* 结果区：生成节点只呈现产物；模型、参数、提示词与运行按钮都在点击展开的面板里 */}
        <div
          className="relative size-full overflow-hidden rounded-xl bg-white shadow-[0_10px_36px_-24px_rgba(0,0,0,0.45)] dark:bg-card"
          onMouseEnter={() => {
            const video = videoRef.current;
            if (!video) {
              return;
            }
            // 默认带声音播放；浏览器拦截未静音自动播放时退回静音，保证画面正常
            void video.play().catch(() => {
              video.muted = true;
              void video.play().catch(() => {});
            });
          }}
          onMouseLeave={() => {
            const video = videoRef.current;
            if (video) {
              video.pause();
              video.currentTime = 0;
            }
          }}
        >
          {running ? (
            streamingPreview ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" src={streamingPreview} className="size-full object-contain" draggable={false} />
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/80 px-2 py-1 backdrop-blur-sm">
                  <span className="size-3 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                  <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{statusLabel || t("nodePreparing")}</span>
                  <button
                    type="button"
                    data-canvas-selectable
                    className="shrink-0 rounded-sm px-1 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (cancelTargetID) handlers.onCancelNode(cancelTargetID);
                    }}
                  >
                    {t("nodeCancel")}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2">
                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted/50 via-transparent to-muted/50" />
                <span className={cn(
                  "relative size-6 animate-spin rounded-full border-2 border-primary/25",
                  isVideo ? "border-t-violet-500" : "border-t-primary",
                )} />
                <p className="relative max-w-[85%] truncate text-[11px] text-muted-foreground">{statusLabel || t("nodePreparing")}</p>
                {isVideo && typeof progress === "number" ? (
                  <div className="relative flex w-[70%] items-center gap-2">
                    <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-violet-500 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
                    </div>
                    <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{Math.min(100, Math.max(0, progress))}%</span>
                  </div>
                ) : null}
                <div className="relative flex items-center gap-1.5">
                  {isVideo ? (
                    <button
                      type="button"
                      data-canvas-selectable
                      className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (resultNode) handlers.onRequeryOutputNode(resultNode.id);
                      }}
                    >
                      <Search className="size-3" strokeWidth={1.8} />
                      {t("nodeRequery")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-canvas-selectable
                    className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (cancelTargetID) handlers.onCancelNode(cancelTargetID);
                    }}
                  >
                    <Square className="size-3" strokeWidth={2} />
                    {t("nodeCancel")}
                  </button>
                </div>
              </div>
            )
          ) : isDone && resultNode ? (
            <>
              {isVideo ? (
                <button
                  type="button"
                  className="size-full"
                  aria-label={t("assetPreviewVideo")}
                  onPointerDown={(event) => {
                    pressRef.current = { x: event.clientX, y: event.clientY };
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    const press = pressRef.current;
                    pressRef.current = null;
                    // 拖动节点后不打开工具栏
                    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
                      return;
                    }
                    // 点击结果只打开对话框与工具栏，不再放大预览
                    handlers.onSelectNode(node.id);
                    handlers.onOpenAssetToolbar(resultNode);
                  }}
                >
                  <video
                    ref={videoRef}
                    src={resultNode.objectURL}
                    loop
                    playsInline
                    preload="metadata"
                    className="size-full object-contain"
                  >
                    <track kind="captions" />
                  </video>
                </button>
              ) : (
                <button
                  type="button"
                  className="size-full cursor-pointer"
                  aria-label={t("nodePreviewTitle")}
                  onPointerDown={(event) => {
                    pressRef.current = { x: event.clientX, y: event.clientY };
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    const press = pressRef.current;
                    pressRef.current = null;
                    // 拖动节点后不打开工具栏
                    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
                      return;
                    }
                    handlers.onSelectNode(node.id);
                    handlers.onOpenAssetToolbar(resultNode);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={resultNode.fileName ?? ""}
                    src={resultNode.objectURL}
                    className="size-full object-contain"
                    draggable={false}
                    onError={() => handlers.onUpdateNode(resultNode.id, { imageLoadFailed: true })}
                  />
                </button>
              )}
              <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/node:opacity-100">
                <OutputActionButton label={isVideo ? t("assetPreviewVideo") : t("nodePreviewTitle")} onClick={() => handlers.onPreviewResult(resultNode)}>
                  <Maximize2 className="size-3.5" strokeWidth={1.8} />
                </OutputActionButton>
                <OutputActionButton label={t("nodeDownload")} onClick={() => handlers.onDownloadNode(resultNode)}>
                  <Download className="size-3.5" strokeWidth={1.8} />
                </OutputActionButton>
                {isVideo ? (
                  <OutputActionButton label={t("assetActions")} onClick={() => handlers.onOpenAssetToolbar(resultNode)}>
                    <Clapperboard className="size-3.5" strokeWidth={1.8} />
                  </OutputActionButton>
                ) : null}
                {isVideo ? null : (
                  <>
                    <OutputActionButton label={t("nodeEdit")} onClick={() => handlers.onEditNode(resultNode)}>
                      <Paintbrush className="size-3.5" strokeWidth={1.8} />
                    </OutputActionButton>
                    <OutputActionButton label={t("nodeUseAsReference")} onClick={() => handlers.onUseAsReference(resultNode)}>
                      <ImagePlus className="size-3.5" strokeWidth={1.8} />
                    </OutputActionButton>
                  </>
                )}
              </div>
              {isVideo && resultNode.durationSeconds ? (
                <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground backdrop-blur-sm">
                  {resultNode.durationSeconds}s
                </span>
              ) : null}
            </>
          ) : errorMessage ? (
            <div className="flex size-full flex-col items-center justify-center gap-1.5 overflow-y-auto p-2 text-center">
              {statusLabel ? (
                <div className="flex flex-col items-center gap-1.5">
                  <span className={cn("size-5 animate-spin rounded-full border-2 border-primary/25", isVideo ? "border-t-violet-500" : "border-t-primary")} />
                  <p className="text-[11px] leading-relaxed break-words text-muted-foreground">{statusLabel}</p>
                </div>
              ) : (
                <>
                  <AlertTriangle className="size-5 shrink-0 text-destructive/80" strokeWidth={1.6} />
                  <p className="text-[11px] leading-relaxed break-words text-muted-foreground">{errorMessage}</p>
                  <button
                    type="button"
                    data-canvas-selectable
                    className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (resultNode) {
                        handlers.onRequeryOutputNode(resultNode.id);
                      } else {
                        handlers.onRequeryNode(node.id);
                      }
                    }}
                  >
                    <Search className="size-3" strokeWidth={1.8} />
                    {t("nodeRequery")}
                  </button>
                </>
              )}
              {node.errorDetail ? <ErrorDetailPanel detail={node.errorDetail} /> : null}
            </div>
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-1.5 p-3 text-center">
              <ImageOff className="size-5 text-muted-foreground/50" strokeWidth={1.5} />
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                {isVideo ? t("generateNodeIdleHintVideo") : t("nodeEmptyHint")}
              </p>
            </div>
          )}
        </div>
        {/* 悬浮名称条：位于节点下方，显示类型图标 + 名称，双击可改名 */}
        <div className="absolute inset-x-0 top-full z-20 mt-1 flex">
          <div className="pointer-events-auto max-w-[80%] rounded-md border border-border/50 bg-background/90 shadow-sm backdrop-blur">
            <AssetNameBar
              kind={isVideo ? "video" : "image"}
              name={node.displayName ?? resultNode?.fileName ?? node.model ?? (isVideo ? t("nodeKindGenerateVideo") : t("nodeKindGenerate"))}
              onRename={(next) => handlers.onUpdateNode(node.id, { displayName: next })}
              className="h-6"
            />
          </div>
        </div>
      </div>
    </GraphNodeShell>
  );
}

// 任务耗时展示：超过一分钟按「分 + 秒」折叠，避免出现 510s 这类难以阅读的数字
function formatElapsedDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

// ---------------------------------------------------------------------------
// 输出节点：生成结果展示与后续操作入口
// ---------------------------------------------------------------------------
function OutputGraphNodeView({
  node,
  selected,
  compatible,
  handlers,
}: {
  node: OutputGraphNode;
  selected: boolean;
  compatible: boolean;
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const [imageLoaded, setImageLoaded] = React.useState(false);
  // 记录按下位置：结果区允许拖动节点，拖动后不误触工具栏
  const pressRef = React.useRef<{ x: number; y: number } | null>(null);
  const isVideo = (node.mediaType ?? (node.mimeType?.startsWith("video/") ? "video" : "image")) === "video";
  // 运行中任务的取消目标：运行控制器按 runID 登记（并发多次生成互不影响）
  const cancelTargetID = node.status === "running" ? node.runID ?? node.sourceGenerateID ?? null : null;
  const displaySource = node.status === "done" ? node.objectURL : undefined;
  // 视频真实时长：上游回传的时长可能是请求参数的缺省值（与成片不一致），
  // 以播放器元数据为准并回写节点，使卡片与资产侧栏显示同一份准确时长
  const [mediaDuration, setMediaDuration] = React.useState<number | null>(null);

  React.useEffect(() => {
    setImageLoaded(false);
    setMediaDuration(null);
  }, [displaySource]);

  React.useEffect(() => {
    if (mediaDuration === null || mediaDuration <= 0) {
      return;
    }
    const rounded = Math.round(mediaDuration);
    if (node.durationSeconds === undefined || Math.abs(node.durationSeconds - rounded) >= 1) {
      handlers.onUpdateNode(node.id, { durationSeconds: rounded });
    }
  }, [handlers, mediaDuration, node.durationSeconds, node.id]);

  const displayDuration = mediaDuration !== null && mediaDuration > 0 ? mediaDuration : node.durationSeconds;

  const copyPrompt = React.useCallback(async () => {
    if (!node.prompt) {
      return;
    }
    try {
      await navigator.clipboard.writeText(node.prompt);
      toast.success(t("copyPromptSuccess"));
    } catch {
      toast.error(t("copyPromptFailed"));
    }
  }, [node.prompt, t]);

  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="output"
      title={isVideo ? t("nodeKindOutputVideo") : t("nodeKindOutput")}
      icon={isVideo
        ? <Clapperboard className="size-3.5 shrink-0 text-violet-500" strokeWidth={1.8} />
        : <Images className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      variant={isVideo ? "video" : undefined}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
    >
      <div className="flex h-full flex-col gap-1.5 p-2.5">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-muted/25">
          {node.status === "running" ? (
            // 任务已转交本节点：等待/流式响应/进度/取消都在输出节点上呈现
            node.previewURL ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt=""
                  src={node.previewURL}
                  className="size-full object-contain"
                  draggable={false}
                  // 上游地址可能无法被浏览器直连：加载失败就退回等待态，保存完成后仍会显示文件
                  onError={() => handlers.onUpdateNode(node.id, { previewURL: undefined })}
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/80 px-2 py-1 backdrop-blur-sm">
                  <span className="size-3 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                  <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                    {node.statusLabel || t("nodePreparing")}
                  </span>
                  {cancelTargetID ? (
                    <span className="flex shrink-0 items-center gap-1">
                      {/* 未完成的任务允许手动重查进度：上游可能已产出结果而当前流尚未收到 */}
                      {isVideo ? (
                        <button
                          type="button"
                          data-canvas-selectable
                          aria-label={t("nodeRequery")}
                          className="rounded-sm px-1 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            handlers.onRequeryOutputNode(node.id);
                          }}
                        >
                          {t("nodeRequery")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-canvas-selectable
                        aria-label={t("nodeCancel")}
                        className="shrink-0 rounded-sm px-1 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          handlers.onCancelNode(cancelTargetID);
                        }}
                      >
                        {t("nodeCancel")}
                      </button>
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2">
                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted/50 via-transparent to-muted/50" />
                <span className={cn(
                  "relative size-6 animate-spin rounded-full border-2 border-primary/25",
                  isVideo ? "border-t-violet-500" : "border-t-primary",
                )} />
                <p className="relative max-w-[85%] truncate text-[11px] text-muted-foreground">
                  {node.statusLabel || t("nodePreparing")}
                </p>
                {/* 视频任务的粒度进度（后端 progress 事件） */}
                {isVideo && typeof node.progress === "number" ? (
                  <div className="relative flex w-[70%] items-center gap-2">
                    <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
                        style={{ width: `${Math.min(100, Math.max(0, node.progress))}%` }}
                      />
                    </div>
                    <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                      {Math.min(100, Math.max(0, node.progress))}%
                    </span>
                  </div>
                ) : null}
                <div className="relative flex items-center gap-1.5">
                  {/* 未完成的任务允许手动重查进度：上游可能已产出结果而当前流尚未收到 */}
                  {isVideo ? (
                    <button
                      type="button"
                      data-canvas-selectable
                      className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        handlers.onRequeryOutputNode(node.id);
                      }}
                    >
                      <Search className="size-3" strokeWidth={1.8} />
                      {t("nodeRequery")}
                    </button>
                  ) : null}
                  {cancelTargetID ? (
                    <button
                      type="button"
                      data-canvas-selectable
                      className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        handlers.onCancelNode(cancelTargetID);
                      }}
                    >
                      <Square className="size-3" strokeWidth={1.8} />
                      {t("nodeCancel")}
                    </button>
                  ) : null}
                </div>
              </div>
            )
          ) : node.status === "error" && node.pendingRetry ? (
            // 生成已成功、保存待重试：重试职责归本输出节点，不占用生成节点
            <div className="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center">
              {node.retrySaving ? (
                <span className={cn(
                  "size-5 animate-spin rounded-full border-2 border-muted-foreground/20",
                  isVideo ? "border-t-violet-500" : "border-t-primary",
                )} />
              ) : (
                <AlertTriangle className="size-5 shrink-0 text-amber-500/90" strokeWidth={1.6} />
              )}
              <p className="text-[11px] leading-relaxed break-words text-muted-foreground">
                {node.errorMessage || t("generateFailed")}
              </p>
              {node.retrySaving ? null : (
                <button
                  type="button"
                  data-canvas-selectable
                  className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handlers.onRetryOutputSave(node.id);
                  }}
                >
                  <RotateCw className="size-3" strokeWidth={1.8} />
                  {t("nodeRetrySave")}
                </button>
              )}
            </div>
          ) : node.status === "error" ? (
            <div className="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center">
              {/* 重查进行中（错误态节点带 statusLabel）：显示加载状态并隐藏重查按钮 */}
              {node.statusLabel ? (
                <div className="flex flex-col items-center gap-1.5">
                  <span className={cn(
                    "size-5 animate-spin rounded-full border-2 border-primary/25",
                    isVideo ? "border-t-violet-500" : "border-t-primary",
                  )} />
                  <p className="text-[11px] leading-relaxed break-words text-muted-foreground">
                    {node.statusLabel}
                  </p>
                </div>
              ) : (
                <>
                  <AlertTriangle className="size-5 shrink-0 text-destructive/80" strokeWidth={1.6} />
                  <p className="text-[11px] leading-relaxed break-words text-muted-foreground">
                    {node.errorMessage || t("generateFailed")}
                  </p>
                  {/* 任务绑定在输出节点上：失败的视频任务可直接在本节点重查上游结果 */}
                  {node.runID && isVideo ? (
                    <button
                      type="button"
                      data-canvas-selectable
                      className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        handlers.onRequeryOutputNode(node.id);
                      }}
                    >
                      <Search className="size-3" strokeWidth={1.8} />
                      {t("nodeRequery")}
                    </button>
                  ) : null}
                </>
              )}
              {node.errorDetail ? <ErrorDetailPanel detail={node.errorDetail} /> : null}
            </div>
          ) : node.status === "done" && isVideo && displaySource ? (
            <>
              {/* 视频产物：原生播放器，桌面与移动端均可触控播放 */}
              {/* biome-ignore lint/a11y/useMediaCaption: 生成视频无字幕源，节点内嵌播放器为非关键媒体展示 */}
              <video
                src={displaySource}
                controls
                preload="metadata"
                playsInline
                className="size-full bg-black/80 object-contain"
                data-canvas-selectable
                onLoadedMetadata={(event) => {
                  const seconds = event.currentTarget.duration;
                  if (Number.isFinite(seconds) && seconds > 0) {
                    setMediaDuration(seconds);
                  }
                }}
              />
              {/* 悬停操作工具条 */}
              <div className="pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/node:opacity-100">
                <OutputActionButton label={t("nodeDownload")} onClick={() => handlers.onDownloadNode(node)}>
                  <Download className="size-3" strokeWidth={1.8} />
                </OutputActionButton>
                <OutputActionButton label={t("assetActions")} onClick={() => handlers.onOpenAssetToolbar(node)}>
                  <Clapperboard className="size-3" strokeWidth={1.8} />
                </OutputActionButton>
                <OutputActionButton label={t("nodeCopyPrompt")} onClick={() => void copyPrompt()}>
                  <Copy className="size-3" strokeWidth={1.8} />
                </OutputActionButton>
              </div>
            </>
          ) : node.status === "done" && displaySource ? (
            <>
              {!imageLoaded ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/50" />
                  <p className="text-[11px] text-muted-foreground">{t("nodeLoadingImage")}</p>
                </div>
              ) : null}
              <button
                type="button"
                aria-label={t("nodePreviewHint")}
                title={t("nodePreviewHint")}
                className="pointer-events-auto block size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                onPointerDown={(event) => {
                  pressRef.current = { x: event.clientX, y: event.clientY };
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  const press = pressRef.current;
                  pressRef.current = null;
                  // 拖动节点后不触发预览
                  if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
                    return;
                  }
                  handlers.onPreviewNode(node);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={node.prompt || node.fileName || "output"}
                  src={displaySource}
                  className={cn(
                    "size-full object-contain transition-opacity duration-300 motion-reduce:transition-none",
                    imageLoaded ? "opacity-100" : "opacity-0",
                  )}
                  onLoad={() => setImageLoaded(true)}
                  onError={() => setImageLoaded(true)}
                  draggable={false}
                />
              </button>
              {/* 悬停操作工具条 */}
              <div className="pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/node:opacity-100">
                <OutputActionButton label={t("nodeDownload")} onClick={() => handlers.onDownloadNode(node)}>
                  <Download className="size-3" strokeWidth={1.8} />
                </OutputActionButton>
                <OutputActionButton label={t("nodeUseAsReference")} onClick={() => handlers.onUseAsReference(node)}>
                  <Repeat2 className="size-3" strokeWidth={1.8} />
                </OutputActionButton>
                <OutputActionButton label={t("nodeEdit")} onClick={() => handlers.onEditNode(node)}>
                  <Paintbrush className="size-3" strokeWidth={1.8} />
                </OutputActionButton>
                <OutputActionButton label={t("nodeCopyPrompt")} onClick={() => void copyPrompt()}>
                  <Copy className="size-3" strokeWidth={1.8} />
                </OutputActionButton>
              </div>
            </>
          ) : node.status === "done" && node.fileID && !node.objectURL ? (
            // 保存完成但本地文件仍在拉取：保留生成时的预览图，避免图片消失再出现
            node.previewURL ? (
              <div className="relative size-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={node.prompt || node.fileName || "output"}
                  src={node.previewURL}
                  className="size-full object-contain"
                  draggable={false}
                  onError={() => handlers.onUpdateNode(node.id, { previewURL: undefined })}
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/80 px-2 py-1 backdrop-blur-sm">
                  <span className="size-3 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                  <span className="truncate text-[10px] text-muted-foreground">{t("nodeLoadingImage")}</span>
                </div>
              </div>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2">
                <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/50" />
                <p className="text-[11px] text-muted-foreground">{t("nodeLoadingImage")}</p>
              </div>
            )
          ) : node.imageLoadFailed ? (
            <div className="flex size-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
              <ImageIcon className="size-5" strokeWidth={1.6} />
              <p className="text-[11px]">{t("nodeImageLoadFailed")}</p>
            </div>
          ) : (
            <div className="flex size-full items-center justify-center gap-1.5 text-muted-foreground/50">
              <Images className="size-4" strokeWidth={1.6} />
              <span className="text-[11px]">{t("outputNodeEmptyHint")}</span>
            </div>
          )}
        </div>

        {/* 元信息 */}
        {node.status === "done" ? (
          <div className="flex shrink-0 items-center justify-between gap-2 text-[10px] text-muted-foreground/80">
            <span className="min-w-0 truncate" title={node.model}>
              {node.model ? graphModelDisplayName(node.model) : null}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {isVideo && displayDuration !== undefined && displayDuration > 0 ? (
                <span className="inline-flex items-center gap-0.5 tabular-nums" title={t("nodeVideoDuration")}>
                  <Clock3 className="size-2.5" aria-hidden="true" />
                  {Math.round(displayDuration)}s
                </span>
              ) : null}
              {node.durationMs !== undefined ? (
                <span className="inline-flex items-center gap-0.5 tabular-nums" title={t("nodeDuration")}>
                  <Clock3 className="size-2.5" aria-hidden="true" />
                  {formatElapsedDuration(node.durationMs)}
                </span>
              ) : null}
              <span>{new Date(node.completedAt ?? node.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
            </span>
          </div>
        ) : null}
      </div>
    </GraphNodeShell>
  );
}

function OutputActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-canvas-selectable
      className="pointer-events-auto flex size-6 items-center justify-center rounded-md border border-border/60 bg-background/85 text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:text-foreground"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

// 图节点统一入口：按节点类型分发渲染
export function GraphNodeView({
  node,
  selected,
  connecting,
  resultNode,
  timelineSources,
  timelineAttachOptions,
  handlers,
}: {
  node: GraphNode;
  selected: boolean;
  connecting: { kind: string; port: GraphPortID; mediaKind?: CanvasMediaKind } | null;
  // 合并节点的输出子节点：生成卡片内的结果与运行态来源
  resultNode: OutputGraphNode | null;
  // 时间线节点的片段来源信息（名称与预览地址），由视口按连线解析后传入
  timelineSources?: TimelineSourceInfo[];
  // 时间线节点可接入的视频来源（+ 按钮菜单）
  timelineAttachOptions?: TimelineAttachOption[];
  handlers: GraphNodeActionHandlers;
}) {
  const compatible = useCompatiblePort(node, connecting);
  switch (node.kind) {
    case "prompt":
      return <PromptGraphNodeView node={node} selected={selected} compatible={compatible} handlers={handlers} />;
    case "image":
      return <ImageGraphNodeView node={node} selected={selected} compatible={compatible} handlers={handlers} />;
    case "generate":
      return (
        <GenerateGraphNodeView
          node={node}
          selected={selected}
          compatible={compatible}
          resultNode={resultNode}
          handlers={handlers}
        />
      );
    case "output":
      return <OutputGraphNodeView node={node} selected={selected} compatible={compatible} handlers={handlers} />;
    case "media":
      return <MediaGraphNodeView node={node} selected={selected} compatible={compatible} handlers={handlers} />;
    case "timeline":
      return (
        <TimelineGraphNodeView
          node={node}
          selected={selected}
          compatible={compatible}
          sources={timelineSources ?? []}
          availableSources={timelineAttachOptions ?? []}
          handlers={handlers}
        />
      );
  }
}
