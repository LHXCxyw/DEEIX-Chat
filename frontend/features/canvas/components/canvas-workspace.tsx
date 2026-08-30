"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";

import { toast } from "sonner";
import { useCanvasModels } from "@/features/canvas/hooks/use-canvas-models";
import type { CanvasReferenceImage } from "@/features/canvas/hooks/use-canvas-store";
import { useCanvasStore } from "@/features/canvas/hooks/use-canvas-store";
import { CanvasImageLightbox } from "@/features/canvas/components/canvas-image-lightbox";
import { CanvasMinimap } from "@/features/canvas/components/canvas-minimap";
import { CanvasPromptBar } from "@/features/canvas/components/canvas-prompt-bar";
import { CanvasToolbar } from "@/features/canvas/components/canvas-toolbar";
import { CanvasViewport } from "@/features/canvas/components/canvas-viewport";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasNode,
  type CanvasViewport as Viewport,
} from "@/features/canvas/model/canvas-types";
import { clampViewportScale } from "@/features/canvas/model/canvas-persist";
import { fetchFileContent } from "@/shared/api/file";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

// 参考图附带来源节点，用于生成结果与父卡片建立连线
type WorkspaceReference = CanvasReferenceImage & { sourceNodeID?: string | null };

export function CanvasWorkspace() {
  const t = useTranslations("canvas");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = React.useState("");
  const [reference, setReference] = React.useState<WorkspaceReference | null>(null);
  const [uploadingReference, setUploadingReference] = React.useState(false);
  const [, setOverlayOpen] = React.useState(false);
  const [previewNode, setPreviewNode] = React.useState<CanvasNode | null>(null);
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
  // 标记参考图预览 URL 是否由本工作区创建（借用节点 objectURL 时不可释放）
  const ownedPreviewRef = React.useRef<string | null>(null);
  const canvasViewportRef = React.useRef<Viewport>({ x: 0, y: 0, scale: 1 });

  const { imageModels, selectedModel, selectModel, modelsLoading, modelsErrorMsg } = useCanvasModels();

  // 视口中心对应的画布坐标，作为新节点落点
  const getSpawnPoint = React.useCallback((): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    const current = canvasViewportRef.current;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { x: 0, y: 0 };
    }
    return {
      x: (rect.width / 2 - current.x) / current.scale,
      y: (rect.height / 2 - current.y) / current.scale,
    };
  }, []);

  const canvas = useCanvasStore({ selectedModel, getSpawnPoint });
  canvasViewportRef.current = canvas.viewport;

  // 容器尺寸用于小地图视口框与适配视图
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const rect = container.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const releaseOwnedPreview = React.useCallback(() => {
    if (ownedPreviewRef.current) {
      URL.revokeObjectURL(ownedPreviewRef.current);
      ownedPreviewRef.current = null;
    }
  }, []);

  React.useEffect(() => releaseOwnedPreview, [releaseOwnedPreview]);

  const replaceReference = React.useCallback(
    (next: CanvasReferenceImage | null) => {
      releaseOwnedPreview();
      setReference(next);
    },
    [releaseOwnedPreview],
  );

  const handleAttachFile = React.useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error(t("referenceNotImage"));
        return;
      }
      setUploadingReference(true);
      try {
        const uploaded = await canvas.uploadReferenceFile(file);
        if (uploaded) {
          releaseOwnedPreview();
          ownedPreviewRef.current = uploaded.previewURL ?? null;
          setReference({ ...uploaded, sourceNodeID: null });
        }
      } finally {
        setUploadingReference(false);
      }
    },
    [canvas, releaseOwnedPreview, t],
  );

  const handleZoom = React.useCallback(
    (direction: "in" | "out") => {
      canvas.setViewportState((current) => ({
        ...current,
        scale: clampViewportScale(
          direction === "in" ? current.scale * 1.25 : current.scale / 1.25,
          CANVAS_MIN_SCALE,
          CANVAS_MAX_SCALE,
        ),
      }));
    },
    [canvas],
  );

  const handleFit = React.useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    canvas.fitViewport({ width: rect.width, height: rect.height });
  }, [canvas]);

  // 小地图导航：将目标画布坐标居中到视口
  const handleMinimapNavigate = React.useCallback(
    (point: { x: number; y: number }) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      canvas.setViewportState((current) => ({
        ...current,
        x: rect.width / 2 - point.x * current.scale,
        y: rect.height / 2 - point.y * current.scale,
      }));
    },
    [canvas],
  );

  const handleDownloadNode = React.useCallback(
    async (node: CanvasNode) => {
      if (node.status !== "done") {
        return;
      }
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("needLogin"));
        return;
      }
      try {
        const result = await fetchFileContent(token, node.fileID);
        const objectURL = URL.createObjectURL(result.blob);
        const anchor = document.createElement("a");
        anchor.href = objectURL;
        anchor.download = node.fileName || "image.png";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
      } catch {
        toast.error(t("downloadFailed"));
      }
    },
    [t],
  );

  // 将已完成节点作为参考图（预览直接借用节点 objectURL，不接管所有权）
  const handleUseAsReference = React.useCallback(
    (node: CanvasNode) => {
      if (node.status !== "done") {
        return;
      }
      releaseOwnedPreview();
      setReference({
        fileID: node.fileID,
        fileName: node.fileName,
        mimeType: node.mimeType,
        sizeBytes: node.sizeBytes,
        previewURL: node.objectURL,
        sourceNodeID: node.id,
      });
      toast.success(t("referenceFromNode"));
    },
    [releaseOwnedPreview, t],
  );

  const handleGenerate = React.useCallback(
    (nextPrompt: string, nextReference: CanvasReferenceImage | null) => {
      const source = nextReference as WorkspaceReference | null;
      canvas.generate(nextPrompt, nextReference, source?.sourceNodeID ?? null);
    },
    [canvas],
  );

  const showEmptyState = canvas.restored && canvas.nodes.length === 0 && !modelsLoading;

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border/60 bg-background/40"
    >
      <CanvasViewport
        nodes={canvas.nodes}
        viewport={canvas.viewport}
        pointerMode={canvas.pointerMode}
        selectedNodeIDs={canvas.selectedNodeIDs}
        interactionLocked={previewNode !== null}
        onSelectedNodeIDsChange={canvas.setSelectedNodeIDs}
        onViewportChange={canvas.setViewportState}
        onMoveNodes={canvas.moveNodes}
        onRemoveNode={canvas.removeNode}
        onCancelNode={canvas.cancelNode}
        onRetryNode={canvas.retryNode}
        onUseAsReference={handleUseAsReference}
        onDownloadNode={(node) => void handleDownloadNode(node)}
        onPreviewNode={setPreviewNode}
      >
        {/* 顶部工具栏 */}
        <CanvasToolbar
          viewport={canvas.viewport}
          nodeCount={canvas.nodes.length}
          generatingCount={canvas.generatingCount}
          pointerMode={canvas.pointerMode}
          onPointerModeChange={canvas.setPointerMode}
          onZoom={handleZoom}
          onReset={canvas.resetViewport}
          onFit={handleFit}
          onClear={canvas.clearCanvas}
        />

        {/* 空状态提示 */}
        {showEmptyState ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="pointer-events-none flex size-16 items-center justify-center rounded-2xl border border-border/60 bg-background/70 shadow-sm backdrop-blur-xl">
              <Sparkles className="size-7 text-primary/80" strokeWidth={1.5} />
            </div>
            <div className="pointer-events-none flex flex-col items-center gap-1.5 text-center">
              <p className="text-base font-semibold tracking-tight text-foreground/90">
                {modelsErrorMsg ? t("loadModelsFailed") : t("emptyTitle")}
              </p>
              <p className="max-w-72 text-xs leading-relaxed text-muted-foreground/70">
                {modelsErrorMsg || (imageModels.length === 0 ? t("noImageModelsHint") : t("emptyHint"))}
              </p>
            </div>
          </div>
        ) : null}

        {/* 右下角区域预览 */}
        {canvas.nodes.length > 0 ? (
          <CanvasMinimap
            nodes={canvas.nodes}
            viewport={canvas.viewport}
            containerSize={containerSize}
            selectedNodeIDs={canvas.selectedNodeIDs}
            onNavigate={handleMinimapNavigate}
          />
        ) : null}

        {/* 底部提示词栏 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 pt-16">
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background via-background/60 to-transparent"
            aria-hidden="true"
          />
          <CanvasPromptBar
            prompt={prompt}
            onPromptChange={setPrompt}
            reference={reference}
            onReferenceChange={replaceReference}
            onGenerate={handleGenerate}
            onAttachFile={(file) => void handleAttachFile(file)}
            uploadingReference={uploadingReference}
            imageModels={imageModels}
            selectedModel={selectedModel}
            onSelectModel={selectModel}
            imageOptions={canvas.imageOptions}
            onImageOptionsChange={canvas.setImageOptions}
            onOverlayOpenChange={setOverlayOpen}
          />
        </div>
      </CanvasViewport>

      {/* 图片放大查看 */}
      <CanvasImageLightbox
        node={previewNode}
        onClose={() => setPreviewNode(null)}
        onDownload={(node) => void handleDownloadNode(node)}
      />
    </div>
  );
}
