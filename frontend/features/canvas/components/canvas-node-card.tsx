"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  Download,
  ImageIcon,
  RefreshCw,
  Repeat2,
  Trash2,
  X,
} from "lucide-react";

import { toast } from "sonner";
import type { CanvasNode } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 指针位移小于该阈值视为点击而非拖拽
const DRAG_CLICK_THRESHOLD = 4;

function NodeActionButton({
  label,
  onClick,
  children,
  destructive,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/60 bg-background/85 text-muted-foreground shadow-sm backdrop-blur-md transition-colors",
        destructive
          ? "hover:border-destructive/40 hover:text-destructive"
          : "hover:text-foreground",
      )}
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

export function CanvasNodeCard({
  node,
  selected,
  onRemove,
  onCancel,
  onRetry,
  onUseAsReference,
  onDownload,
  onPreview,
}: {
  node: CanvasNode;
  selected: boolean;
  onRemove: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onUseAsReference: () => void;
  onDownload: () => void;
  onPreview: () => void;
}) {
  const t = useTranslations("canvas");
  const [imageLoaded, setImageLoaded] = React.useState(false);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const pressPointRef = React.useRef<{ x: number; y: number } | null>(null);

  const displaySource =
    node.status === "done" ? node.objectURL : node.status === "streaming" ? node.previewURL : undefined;

  React.useEffect(() => {
    setImageLoaded(false);
  }, [displaySource]);

  const copyPrompt = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(node.prompt);
      toast.success(t("copyPromptSuccess"));
    } catch {
      toast.error(t("copyPromptFailed"));
    }
  }, [node.prompt, t]);

  const copyError = React.useCallback(async () => {
    if (node.status !== "error") {
      return;
    }
    const text = [node.errorMessage, node.errorDetail].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copyErrorSuccess"));
    } catch {
      toast.error(t("copyPromptFailed"));
    }
  }, [node, t]);

  const isGenerating = node.status === "pending" || node.status === "streaming";

  return (
    <div
      className={cn(
        "group relative cursor-grab overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg shadow-black/5 transition-shadow select-none active:cursor-grabbing",
        selected ? "border-primary/70 ring-2 ring-primary/25" : "border-border hover:border-border/80",
      )}
    >
      {/* 图像区域 */}
      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-muted/40">
        {displaySource ? (
          <>
            {!imageLoaded ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/50" />
              </div>
            ) : null}
            {/* 图片可右键复制/另存；单击（非拖拽）放大查看，按钮包裹以支持键盘操作 */}
            <button
              type="button"
              aria-label={t("nodePreviewHint")}
              title={t("nodePreviewHint")}
              disabled={node.status !== "done"}
              className="size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-default"
              onPointerDown={(event) => {
                // 不阻断冒泡，保持从图片处拖动卡片；记录起点用于区分点击与拖拽
                pressPointRef.current = { x: event.clientX, y: event.clientY };
              }}
              onClick={(event) => {
                event.stopPropagation();
                const press = pressPointRef.current;
                pressPointRef.current = null;
                if (
                  press &&
                  Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_CLICK_THRESHOLD
                ) {
                  return;
                }
                onPreview();
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={node.prompt}
                className={cn(
                  "size-full object-contain transition-opacity duration-300",
                  imageLoaded ? "opacity-100" : "opacity-0",
                )}
                src={displaySource}
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageLoaded(true)}
              />
            </button>
          </>
        ) : node.status === "error" ? (
          // 选中后文本才可选，避免整块吞掉卡片拖拽
          <div
            {...(selected ? { "data-canvas-selectable": "" } : {})}
            className={cn(
              "flex size-full flex-col items-center justify-center gap-2 overflow-y-auto px-3 py-3 text-center",
              selected ? "select-text" : "select-none",
            )}
          >
            <AlertTriangle className="size-6 shrink-0 text-destructive/80" strokeWidth={1.6} />
            <p className="text-xs leading-relaxed break-words text-muted-foreground">
              {node.errorMessage}
            </p>
            {node.errorDetail ? (
              <div className="w-full">
                <button
                  type="button"
                  className="pointer-events-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDetailOpen((current) => !current);
                  }}
                >
                  <ChevronDown
                    className={cn("size-3 transition-transform", detailOpen && "rotate-180")}
                    strokeWidth={1.8}
                  />
                  {t("nodeErrorRawResponse")}
                </button>
                {detailOpen ? (
                  <pre
                    data-canvas-selectable
                    className="mt-1 max-h-40 w-full overflow-auto rounded-md bg-muted/60 p-2 text-left font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground select-text"
                  >
                    {node.errorDetail}
                  </pre>
                ) : null}
              </div>
            ) : null}
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                className="pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onRetry();
                }}
              >
                <RefreshCw className="size-3" strokeWidth={1.8} />
                {t("nodeRetry")}
              </button>
              <button
                type="button"
                className="pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void copyError();
                }}
              >
                <Copy className="size-3" strokeWidth={1.8} />
                {t("nodeCopyError")}
              </button>
            </div>
          </div>
        ) : node.status === "done" && node.imageLoadFailed ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageIcon className="size-6" strokeWidth={1.6} />
            <p className="text-xs">{t("nodeImageLoadFailed")}</p>
          </div>
        ) : (
          <div className="relative flex size-full flex-col items-center justify-center gap-3 overflow-hidden">
            <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted/60 via-muted/30 to-muted/60" />
            <div className="relative flex size-10 items-center justify-center rounded-full border border-primary/25 bg-primary/10">
              <span className="size-4 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
            </div>
            <p className="relative max-w-[85%] truncate text-[11px] font-medium text-muted-foreground">
              {node.status === "done"
                ? t("nodeLoadingImage")
                : node.statusLabel || t("nodePreparing")}
            </p>
          </div>
        )}

        {/* 生成中的取消按钮 */}
        {isGenerating ? (
          <button
            type="button"
            aria-label={t("nodeCancel")}
            title={t("nodeCancel")}
            className="pointer-events-auto absolute top-2 right-2 flex size-7 items-center justify-center rounded-md border border-border/60 bg-background/85 text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
          >
            <X className="size-3.5" strokeWidth={1.8} />
          </button>
        ) : null}
      </div>

      {/* 信息栏 */}
      <div className="relative rounded-b-xl border-t border-border/70 bg-card/95 px-3 py-2 backdrop-blur-sm">
        <p
          {...(selected ? { "data-canvas-selectable": "" } : {})}
          className={cn(
            "line-clamp-2 text-[11px] leading-relaxed text-foreground/85",
            selected ? "select-text" : "select-none",
          )}
          title={node.prompt}
        >
          {node.prompt}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] font-medium tracking-wide text-muted-foreground/80">
            {node.model}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {node.reference ? (
              <span
                className="rounded-sm bg-primary/10 px-1 py-0.5 text-[9px] font-semibold text-primary"
                title={node.reference.fileName}
              >
                {t("nodeFromReference")}
              </span>
            ) : null}
            {node.status === "done" ? (
              <span className="text-[10px] text-muted-foreground/60">
                {new Date(node.createdAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* 悬停操作工具条 */}
      <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {node.status === "done" ? (
          <>
            <NodeActionButton label={t("nodeDownload")} onClick={onDownload}>
              <Download className="size-3.5" strokeWidth={1.8} />
            </NodeActionButton>
            <NodeActionButton label={t("nodeUseAsReference")} onClick={onUseAsReference}>
              <Repeat2 className="size-3.5" strokeWidth={1.8} />
            </NodeActionButton>
            <NodeActionButton label={t("nodeRetry")} onClick={onRetry}>
              <RefreshCw className="size-3.5" strokeWidth={1.8} />
            </NodeActionButton>
          </>
        ) : null}
        <NodeActionButton label={t("nodeCopyPrompt")} onClick={copyPrompt}>
          <Copy className="size-3.5" strokeWidth={1.8} />
        </NodeActionButton>
      </div>

      {/* 删除按钮（非生成中常驻右上） */}
      {!isGenerating ? (
        <div className="pointer-events-none absolute top-2 right-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <NodeActionButton label={t("nodeDelete")} onClick={onRemove} destructive>
            <Trash2 className="size-3.5" strokeWidth={1.8} />
          </NodeActionButton>
        </div>
      ) : null}
    </div>
  );
}
