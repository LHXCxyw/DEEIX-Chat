"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  ImageIcon,
  ImageOff,
  ImagePlus,
  Images,
  ListOrdered,
  Paintbrush,
  Pencil,
  Play,
  Repeat2,
  Square,
  TextCursorInput,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import type { CanvasReferenceImage } from "@/features/canvas/hooks/use-canvas-store";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { PromptTemplateLibrary } from "@/features/canvas/components/canvas-prompt-template-library";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import { CanvasImageParams } from "@/features/canvas/components/canvas-image-params";
import { GraphNodeShell } from "@/features/canvas/components/canvas-graph-node-shell";
import {
  graphNodePorts,
  isGraphPortCompatibleTarget,
  type GraphPortID,
} from "@/features/canvas/model/canvas-graph";
import {
  type GenerateGraphNode,
  type GraphNode,
  type GraphNodeUpdate,
  type ImageGraphNode,
  type OutputGraphNode,
  type PromptGraphNode,
  graphNodeSize,
  PROMPT_MAX_LENGTH,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

export type GraphNodeActionHandlers = {
  onUpdateNode: (nodeID: string, patch: GraphNodeUpdate) => void;
  // 参考图节点预览缺失时按 fileID 拉取（刷新恢复 / 跨节点拖入后触发）
  onEnsureNodePreview: (nodeID: string) => void;
  onRemoveNode: (nodeID: string) => void;
  onRunNode: (nodeID: string) => void;
  onCancelNode: (nodeID: string) => void;
  onPreviewNode: (node: OutputGraphNode) => void;
  onDownloadNode: (node: OutputGraphNode) => void;
  onEditNode: (node: OutputGraphNode) => void;
  onEditReferenceNode: (node: ImageGraphNode) => void;
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
function useCompatiblePort(node: GraphNode, connecting: { kind: string; port: GraphPortID } | null): boolean {
  return React.useMemo(() => {
    if (!connecting) {
      return false;
    }
    const ports = graphNodePorts(node.kind);
    return ports.some(
      (port) =>
        port.direction === "in" &&
        isGraphPortCompatibleTarget(
          connecting.kind as GraphNode["kind"],
          node.kind,
          port.id,
        ),
    );
  }, [connecting, node.kind]);
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
        </div>
      </div>
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
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);

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
    >
      <div className="h-full p-2.5">
        {node.reference ? (
          <div
            className={cn(
              "group/ref relative h-full overflow-hidden rounded-lg border border-border/50 bg-muted/30 transition-colors",
              dragOver && "border-primary/70 ring-2 ring-primary/30",
            )}
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
            <div className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between gap-1.5 rounded-lg bg-background/85 px-2 py-1 opacity-0 backdrop-blur-md transition-opacity group-hover/ref:opacity-100">
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                {node.reference.fileName}
              </span>
              <div data-canvas-selectable className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={t("editReference")}
                  title={t("editReference")}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => handlers.onEditReferenceNode(node)}
                >
                  <Pencil className="size-3" strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  aria-label={t("attachReference")}
                  title={t("attachReference")}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload className="size-3" strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  aria-label={t("removeReference")}
                  title={t("removeReference")}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    handlers.onUpdateNode(node.id, { reference: null, previewURL: undefined, previewFailed: false })
                  }
                >
                  <Trash2 className="size-3" strokeWidth={1.8} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <label
            data-canvas-selectable
            data-canvas-image-drop
            className={cn(
              "pointer-events-auto flex h-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-background/40 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
              dragOver && "border-primary/60 bg-primary/5 text-foreground",
            )}
            {...dropProps}
          >
            <input
              ref={inputRef}
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
// 生成节点：模型选择、参数配置、运行状态与结果预览
// ---------------------------------------------------------------------------
function GenerateGraphNodeView({
  node,
  selected,
  compatible,
  imageModels,
  inputSummary,
  handlers,
}: {
  node: GenerateGraphNode;
  selected: boolean;
  compatible: boolean;
  imageModels: ChatModelOption[];
  inputSummary: { prompts: number; references: number };
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const model = React.useMemo(
    () => imageModels.find((item) => item.platformModelName === node.model) ?? null,
    [imageModels, node.model],
  );
  const running = node.runStatus === "pending" || node.runStatus === "streaming";

  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="generate"
      title={t("nodeKindGenerate")}
      icon={<ListOrdered className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
    >
      <div className="flex h-full flex-col gap-2 p-2.5">
        {/* 上游输入摘要 */}
        <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 font-medium",
              inputSummary.prompts > 0 ? "bg-violet-500/10 text-violet-600 dark:text-violet-300" : "bg-muted text-muted-foreground/60",
            )}
          >
            {t("inputPromptCount", { count: inputSummary.prompts })}
          </span>
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 font-medium",
              inputSummary.references > 0 ? "bg-sky-500/10 text-sky-600 dark:text-sky-300" : "bg-muted text-muted-foreground/60",
            )}
          >
            {t("inputReferenceCount", { count: inputSummary.references })}
          </span>
        </div>

        {/* 模型与参数 */}
        <div data-canvas-selectable className="shrink-0 space-y-1.5">
          <CanvasModelSelect
            imageModels={imageModels}
            selectedModel={model}
            onSelect={(modelName) => handlers.onUpdateNode(node.id, { model: modelName })}
            className="w-full justify-between"
          />
          <CanvasImageParams
            model={model}
            options={node.options}
            onOptionsChange={(options) => handlers.onUpdateNode(node.id, { options })}
            resultCount={node.resultCount}
            onResultCountChange={(resultCount) => handlers.onUpdateNode(node.id, { resultCount })}
            className="w-full justify-between"
          />
        </div>

        {/* 运行状态区 */}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-muted/25">
          {running ? (
            node.previewURL ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" src={node.previewURL} className="size-full object-contain" draggable={false} />
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/80 px-2 py-1 backdrop-blur-sm">
                  <span className="size-3 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                  <span className="truncate text-[10px] text-muted-foreground">
                    {node.statusLabel || t("nodePreparing")}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2">
                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted/50 via-transparent to-muted/50" />
                <span className="relative size-6 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                <p className="relative max-w-[85%] truncate text-[11px] text-muted-foreground">
                  {node.statusLabel || t("nodePreparing")}
                </p>
              </div>
            )
          ) : node.errorMessage ? (
            <div className="flex size-full flex-col items-center justify-center gap-1.5 overflow-y-auto p-2 text-center">
              <AlertTriangle className="size-5 shrink-0 text-destructive/80" strokeWidth={1.6} />
              <p className="text-[11px] leading-relaxed break-words text-muted-foreground">
                {node.errorMessage}
              </p>
              {node.errorDetail ? (
                <div className="w-full">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDetailOpen((current) => !current);
                    }}
                  >
                    <ChevronDown className={cn("size-3 transition-transform", detailOpen && "rotate-180")} strokeWidth={1.8} />
                    {t("nodeErrorRawResponse")}
                  </button>
                  {detailOpen ? (
                    <pre
                      data-canvas-selectable
                      className="mt-1 max-h-28 w-full overflow-auto rounded-md bg-muted/60 p-1.5 text-left font-mono text-[9px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground select-text"
                    >
                      {node.errorDetail}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex size-full items-center justify-center gap-1.5 text-muted-foreground/50">
              <Images className="size-4" strokeWidth={1.6} />
              <span className="text-[11px]">{t("generateNodeIdleHint")}</span>
            </div>
          )}
        </div>

        {/* 运行按钮 */}
        <button
          type="button"
          data-canvas-selectable
          disabled={!model}
          className={cn(
            "pointer-events-auto flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg text-xs font-semibold text-primary-foreground shadow-sm transition-all",
            "bg-primary hover:bg-primary/90 active:scale-[0.98]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (running) {
              handlers.onCancelNode(node.id);
            } else {
              handlers.onRunNode(node.id);
            }
          }}
        >
          {running ? (
            <>
              <Square className="size-3.5" strokeWidth={2} />
              {t("nodeCancel")}
            </>
          ) : (
            <>
              <Play className="size-3.5" strokeWidth={2} />
              {t("generateNodeRun")}
            </>
          )}
        </button>
      </div>
    </GraphNodeShell>
  );
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
  const displaySource = node.status === "done" ? node.objectURL : undefined;

  React.useEffect(() => {
    setImageLoaded(false);
  }, [displaySource]);

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
      title={t("nodeKindOutput")}
      icon={<Images className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
    >
      <div className="flex h-full flex-col gap-1.5 p-2.5">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-muted/25">
          {node.status === "error" ? (
            <div className="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center">
              <AlertTriangle className="size-5 shrink-0 text-destructive/80" strokeWidth={1.6} />
              <p className="text-[11px] leading-relaxed break-words text-muted-foreground">
                {node.errorMessage || t("generateFailed")}
              </p>
            </div>
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
                data-canvas-selectable
                className="pointer-events-auto block size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
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
            // 图像文件拉取中（objectURL 尚未就绪）：加载动画 + 文字
            <div className="flex size-full flex-col items-center justify-center gap-2">
              <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/50" />
              <p className="text-[11px] text-muted-foreground">{t("nodeLoadingImage")}</p>
            </div>
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
              {node.model}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {node.durationMs !== undefined ? (
                <span className="inline-flex items-center gap-0.5 tabular-nums">
                  <Clock3 className="size-2.5" aria-hidden="true" />
                  {Math.round(node.durationMs / 1000)}s
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
  imageModels,
  inputSummary,
  handlers,
}: {
  node: GraphNode;
  selected: boolean;
  connecting: { kind: string; port: GraphPortID } | null;
  imageModels: ChatModelOption[];
  inputSummary: { prompts: number; references: number };
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
          imageModels={imageModels}
          inputSummary={inputSummary}
          handlers={handlers}
        />
      );
    case "output":
      return <OutputGraphNodeView node={node} selected={selected} compatible={compatible} handlers={handlers} />;
  }
}
