"use client";

import { AudioLines, RefreshCw, Upload, Video } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { GraphNodeShell } from "@/features/canvas/components/canvas-graph-node-shell";
import type { GraphNodeActionHandlers } from "@/features/canvas/components/canvas-graph-nodes";
import { graphNodeSize, type MediaGraphNode } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 参考媒体节点：上传一段参考视频或参考音频，通过出端口接入视频生成节点
export function MediaGraphNodeView({
  node,
  selected,
  compatible,
  handlers,
}: {
  node: MediaGraphNode;
  selected: boolean;
  compatible: boolean;
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const isVideo = node.mediaKind === "video";

  // 预览缺失（刷新恢复、跨节点拖入）时按 fileID 拉取
  React.useEffect(() => {
    if (node.reference && !node.previewURL) {
      handlers.onEnsureNodePreview(node.id);
    }
  }, [handlers, node.id, node.previewURL, node.reference]);

  const handleFile = React.useCallback(
    async (file: File) => {
      if (!file.type.startsWith(isVideo ? "video/" : "audio/")) {
        toast.error(isVideo ? t("referenceNotVideo") : t("referenceNotAudio"));
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
    [handlers, isVideo, node.id, t],
  );

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      const expected = isVideo ? "video/" : "audio/";
      if (!Array.from(event.dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith(expected))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: React.DragEvent) => {
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
      kind="media"
      title={isVideo ? t("nodeKindMediaVideo") : t("nodeKindMediaAudio")}
      icon={isVideo
        ? <Video className="size-3.5 shrink-0 text-fuchsia-500" strokeWidth={1.8} />
        : <AudioLines className="size-3.5 shrink-0 text-fuchsia-500" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
    >
      <div className="flex h-full flex-col gap-2 p-2.5">
        <input
          ref={inputRef}
          type="file"
          accept={isVideo ? "video/*" : "audio/*"}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) {
              void handleFile(file);
            }
          }}
        />
        <div
          data-canvas-selectable
          {...dropProps}
          className={cn(
            "relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-dashed border-border/60 bg-muted/25 p-2 text-center transition-colors",
            dragOver && "border-fuchsia-500/60 bg-fuchsia-500/5",
          )}
        >
          {node.uploading ? (
            <span className="size-5 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
          ) : node.reference ? (
            <>
              {node.previewURL ? (
                isVideo ? (
                  // biome-ignore lint/a11y/useMediaCaption: 参考视频为用户上传素材，无字幕轨道，节点内嵌播放器仅作预览
                  <video src={node.previewURL} controls className="size-full rounded-md object-contain" />
                ) : (
                  // biome-ignore lint/a11y/useMediaCaption: 参考音频为用户上传素材，无字幕轨道，节点内嵌播放器仅作预览
                  <audio src={node.previewURL} controls className="w-full" />
                )
              ) : (
                <div className="flex flex-col items-center gap-1 px-2">
                  {isVideo
                    ? <Video className="size-5 text-muted-foreground" strokeWidth={1.6} />
                    : <AudioLines className="size-5 text-muted-foreground" strokeWidth={1.6} />}
                  <p className="w-full truncate text-[11px] text-muted-foreground">{node.reference.fileName}</p>
                </div>
              )}
              <button
                type="button"
                data-canvas-selectable
                className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                <RefreshCw className="size-3" strokeWidth={1.8} />
                {t("mediaReplace")}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-canvas-selectable
              className="flex flex-col items-center gap-1.5 rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                inputRef.current?.click();
              }}
            >
              <Upload className="size-4" strokeWidth={1.8} />
              <span className="text-[11px]">{isVideo ? t("mediaUploadVideo") : t("mediaUploadAudio")}</span>
            </button>
          )}
        </div>
        {node.reference ? (
          <p className="shrink-0 truncate text-[10px] text-muted-foreground">
            {node.reference.fileName}
          </p>
        ) : null}
      </div>
    </GraphNodeShell>
  );
}
