"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Trash2, X } from "lucide-react";

import { toast } from "sonner";
import { useCanvasModels } from "@/features/canvas/hooks/use-canvas-models";
import type { CanvasReferenceImage } from "@/features/canvas/hooks/use-canvas-store";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { useCanvasStore } from "@/features/canvas/hooks/use-canvas-store";
import { CanvasImageLightbox } from "@/features/canvas/components/canvas-image-lightbox";
import { CanvasImageEditor } from "@/features/canvas/components/canvas-image-editor";
import { CanvasRegenerateDialog } from "@/features/canvas/components/canvas-regenerate-dialog";
import { CanvasAssetSidebar } from "@/features/canvas/components/canvas-asset-sidebar";
import { CanvasCompare } from "@/features/canvas/components/canvas-compare";
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
import { selectedNodeIDsForFilter } from "@/features/canvas/model/canvas-interactions";
import { clampViewportScale, parseCanvasState } from "@/features/canvas/model/canvas-persist";
import { fetchFileContent } from "@/shared/api/file";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

// 参考图附带来源节点，用于生成结果与父卡片建立连线
type WorkspaceReference = CanvasReferenceImage & { sourceNodeID?: string | null };

export function CanvasWorkspace() {
  const t = useTranslations("canvas");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = React.useState("");
  const [references, setReferences] = React.useState<WorkspaceReference[]>([]);
  const [uploadingReference, setUploadingReference] = React.useState(false);
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const [previewNode, setPreviewNode] = React.useState<CanvasNode | null>(null);
  const [filter, setFilter] = React.useState<"all" | "pending" | "streaming" | "done" | "error">("all");
  const [editingNode, setEditingNode] = React.useState<CanvasNode | null>(null);
  const [comparing, setComparing] = React.useState(false);
  const [panel, setPanel] = React.useState<"projects" | "templates" | "history" | null>(null);
  const [showStructureTip, setShowStructureTip] = React.useState(false);
  // 资产列表侧边栏折叠状态（展开时隐藏右下角小地图，避免重叠）
  const [assetsCollapsed, setAssetsCollapsed] = React.useState(false);
  const importInputRef = React.useRef<HTMLInputElement | null>(null);
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
  // 标记上传参考图创建的预览 URL（借用节点 objectURL 时不接管所有权）
  const ownedPreviewRef = React.useRef(new Set<string>());
  const canvasViewportRef = React.useRef<Viewport>({ x: 0, y: 0, scale: 1 });

  const { imageModels, selectedModel, selectModel, modelsLoading, modelsErrorMsg } = useCanvasModels();

  // 资产侧边栏折叠状态持久化（SSR 安全：挂载后再读取本地存储）
  React.useEffect(() => {
    if (window.localStorage.getItem("deeix-canvas-assets-collapsed") === "1") {
      setAssetsCollapsed(true);
    }
  }, []);

  const handleAssetsCollapsedChange = React.useCallback((next: boolean) => {
    setAssetsCollapsed(next);
    window.localStorage.setItem("deeix-canvas-assets-collapsed", next ? "1" : "0");
  }, []);

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

  const releaseOwnedPreviews = React.useCallback(() => {
    for (const url of ownedPreviewRef.current) {
      URL.revokeObjectURL(url);
    }
    ownedPreviewRef.current.clear();
  }, []);

  React.useEffect(() => releaseOwnedPreviews, [releaseOwnedPreviews]);

  const replaceReferences = React.useCallback((next: CanvasReferenceImage[]) => {
    setReferences(next);
  }, []);

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
          if (uploaded.previewURL) {
            ownedPreviewRef.current.add(uploaded.previewURL);
          }
          setReferences((current) => [...current, { ...uploaded, sourceNodeID: null }]);
        }
      } finally {
        setUploadingReference(false);
      }
    },
    [canvas, t],
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

  const handleFocusRegion = React.useCallback((region: { x: number; y: number; width: number; height: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const padding = 64;
    const scale = clampViewportScale(
      Math.min((rect.width - padding * 2) / region.width, (rect.height - padding * 2) / region.height),
      CANVAS_MIN_SCALE,
      CANVAS_MAX_SCALE,
    );
    canvas.setViewportState({
      x: (rect.width - region.width * scale) / 2 - region.x * scale,
      y: (rect.height - region.height * scale) / 2 - region.y * scale,
      scale,
    });
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
    async (node: CanvasNode, silent = false): Promise<boolean> => {
      if (node.status !== "done") {
        return false;
      }
      const token = await resolveAccessToken();
      if (!token) {
        if (!silent) toast.error(t("needLogin"));
        return false;
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
        return true;
      } catch {
        if (!silent) toast.error(t("downloadFailed"));
        return false;
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
      setReferences((current) => current.some((item) => item.fileID === node.fileID)
        ? current
        : [...current, {
          fileID: node.fileID,
          fileName: node.fileName,
          mimeType: node.mimeType,
          sizeBytes: node.sizeBytes,
          previewURL: node.objectURL,
          sourceNodeID: node.id,
        }]);
      toast.success(t("referenceFromNode"));
    },
    [t],
  );

  React.useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const handleKeyDown = (event: KeyboardEvent) => {
      if (previewNode || isEditable(event.target)) {
        return;
      }
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          canvas.redo();
        } else {
          canvas.undo();
        }
        return;
      }
      if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        canvas.redo();
        return;
      }
      if (command && event.key.toLowerCase() === "a") {
        event.preventDefault();
        canvas.setSelectedNodeIDs(canvas.nodes.map((node) => node.id));
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        (canvas.selectedNodeIDs.length > 0 || canvas.selectedDecorationIDs.length > 0)
      ) {
        event.preventDefault();
        canvas.removeSelected();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canvas, previewNode]);

  React.useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (previewNode || event.defaultPrevented) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      const file = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (!file) {
        return;
      }
      event.preventDefault();
      void handleAttachFile(file);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [handleAttachFile, previewNode]);

  const handleGenerate = React.useCallback(
    (nextPrompt: string, nextReferences: CanvasReferenceImage[], resultCount: number) => {
      const sources = nextReferences as WorkspaceReference[];
      const parentID = sources.find((item) => item.sourceNodeID)?.sourceNodeID ?? null;
      for (let index = 0; index < resultCount; index += 1) {
        canvas.generate(nextPrompt, nextReferences, parentID);
      }
    },
    [canvas],
  );

  const visibleNodes = filter === "all" ? canvas.nodes : canvas.nodes.filter((node) => node.status === filter);
  const selectedNodes = canvas.nodes.filter((node) => canvas.selectedNodeIDs.includes(node.id));
  const selectedResultCount = selectedNodes.filter((node) => node.status === "done").length;
  const selectedElementCount = canvas.selectedNodeIDs.length + canvas.selectedDecorationIDs.length;

  const handleFilterChange = React.useCallback((nextFilter: typeof filter) => {
    setFilter(nextFilter);
    canvas.setSelectedNodeIDs(selectedNodeIDsForFilter(canvas.selectedNodeIDs, canvas.nodes, nextFilter));
  }, [canvas]);

  const reportOperation = React.useCallback((action: string, operation: () => void, valid = true) => {
    if (!valid) {
      toast.error(t("operationFailed", { action }));
      return;
    }
    operation();
    toast.success(t("operationSuccess", { action }));
  }, [t]);

  const handleAlign = React.useCallback(() => {
    if (canvas.arrangeSelected("horizontal")) {
      toast.success(t("alignSuccess"));
    } else {
      toast.error(t("operationFailed", { action: t("alignDistribute") }));
    }
  }, [canvas, t]);

  const handleLayer = React.useCallback(() => {
    if (canvas.arrangeSelected("front")) {
      toast.success(t("layerSuccess"));
    } else {
      toast.error(t("operationFailed", { action: t("layers") }));
    }
  }, [canvas, t]);

  const handleLock = React.useCallback(() => {
    const selected = [
      ...canvas.nodes.filter((item) => canvas.selectedNodeIDs.includes(item.id)),
      ...canvas.decorations.filter((item) => canvas.selectedDecorationIDs.includes(item.id)),
    ];
    const locking = selected.some((item) => !item.locked);
    reportOperation(locking ? t("lockSelected") : t("unlockSelected"), canvas.toggleLockSelected, selected.length > 0);
  }, [canvas, reportOperation, t]);

  React.useEffect(() => {
    const nextSelection = selectedNodeIDsForFilter(canvas.selectedNodeIDs, canvas.nodes, filter);
    if (nextSelection.length !== canvas.selectedNodeIDs.length) {
      canvas.setSelectedNodeIDs(nextSelection);
    }
  }, [canvas.nodes, canvas.selectedNodeIDs, canvas.setSelectedNodeIDs, filter]);

  const handleReuseParameters = React.useCallback((node: CanvasNode) => {
    setPrompt(node.prompt);
    selectModel(node.model);
    canvas.setImageOptions(node.options ?? {});
    toast.success(t("parametersReused"));
  }, [canvas, selectModel, t]);

  // 编辑提示词重新生成：沿用原图的参考图/模型/参数，以原图为父节点派生新卡片
  const [regenNode, setRegenNode] = React.useState<CanvasNode | null>(null);

  const handleRegenerateSubmit = React.useCallback((prompt: string) => {
    if (!regenNode) return;
    selectModel(regenNode.model);
    canvas.generate(prompt, regenNode.references ?? [], regenNode.id, null, undefined, regenNode.options ?? {});
    setRegenNode(null);
    toast.success(t("regenerateQueued"));
  }, [canvas, regenNode, selectModel, t]);

  const handleBatchExport = React.useCallback(async () => {
    const downloadable = selectedNodes.filter((node) => node.status === "done");
    const results = await Promise.all(downloadable.map((node) => handleDownloadNode(node, true)));
    const exportedCount = results.filter(Boolean).length;
    if (exportedCount > 0) {
      toast.success(t("batchExported", { count: exportedCount }));
    }
    if (exportedCount < downloadable.length) {
      toast.error(t("batchExportFailed", { count: downloadable.length - exportedCount }));
    }
  }, [handleDownloadNode, selectedNodes, t]);

  const handleEditorSubmit = React.useCallback(async ({ prompt: nextPrompt, mode, image, mask, model }: { prompt: string; mode: "inpaint" | "crop" | "outpaint"; image: File; mask?: File; model: ChatModelOption }): Promise<boolean> => {
    if (!editingNode) return false;
    const source = await canvas.uploadReferenceFile(image);
    const maskReference = mask ? await canvas.uploadReferenceFile(mask) : null;
    if (!source || (mask && !maskReference)) return false;
    selectModel(model.platformModelName);
    const imageOptions = model.platformModelName === editingNode.model ? editingNode.options ?? {} : {};
    canvas.generate(nextPrompt, [source], editingNode.id, maskReference, mode, imageOptions, model);
    return true;
  }, [canvas, editingNode, selectModel]);

  const handleExportProject = React.useCallback(() => {
    const blob = new Blob([canvas.exportProject()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${canvas.projectName.replace(/[^a-zA-Z0-9_-]+/g, "-") || "canvas"}.json`; anchor.click();
    URL.revokeObjectURL(url);
  }, [canvas]);

  const handleImportProject = React.useCallback(async (file: File) => {
    const parsed = parseCanvasState(await file.text());
    if (!parsed) { toast.error(t("importInvalid")); return; }
    canvas.importProject(parsed); toast.success(t("importSuccess"));
  }, [canvas, t]);

  const showEmptyState = canvas.restored && canvas.nodes.length === 0 && canvas.decorations.length === 0 && !modelsLoading;
  const addStructure = React.useCallback((kind: "frame" | "section") => {
    canvas.addDecoration(kind, getSpawnPoint());
    if (typeof window !== "undefined" && window.localStorage.getItem("deeix-canvas-structure-tip") !== "seen") {
      setShowStructureTip(true);
      window.localStorage.setItem("deeix-canvas-structure-tip", "seen");
    }
  }, [canvas, getSpawnPoint]);

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border/60 bg-background/40 font-sans"
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"))) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        const images = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
        if (images.length === 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void Promise.all(images.map(handleAttachFile));
      }}
    >
      <CanvasViewport
        nodes={visibleNodes}
        decorations={canvas.decorations}
        viewport={canvas.viewport}
        pointerMode={canvas.pointerMode}
        selectedNodeIDs={canvas.selectedNodeIDs}
        selectedDecorationIDs={canvas.selectedDecorationIDs}
        interactionLocked={previewNode !== null || overlayOpen || regenNode !== null}
        containerSize={containerSize}
        onSelectedNodeIDsChange={canvas.setSelectedNodeIDs}
        onSelectedDecorationIDsChange={canvas.setSelectedDecorationIDs}
        onPointerModeChange={canvas.setPointerMode}
        onUpdateDecoration={canvas.updateDecoration}
        onMoveDecoration={canvas.moveDecoration}
        onFocusRegion={handleFocusRegion}
        onViewportChange={canvas.setViewportState}
        onBeginNodeMove={canvas.beginNodeMove}
        onMoveNodes={canvas.moveNodes}
        onEndNodeMove={canvas.endNodeMove}
        onRemoveNode={canvas.removeNode}
        onCancelNode={canvas.cancelNode}
        onRetryNode={canvas.retryNode}
        onUseAsReference={handleUseAsReference}
        onReuseParameters={handleReuseParameters}
        onRegenerateNode={setRegenNode}
        onEditNode={setEditingNode}
        onDownloadNode={(node) => void handleDownloadNode(node)}
        onPreviewNode={setPreviewNode}
      >
        {/* 顶部工具栏 */}
        <CanvasToolbar
          viewport={canvas.viewport}
          nodeCount={canvas.nodes.length}
          elementCount={canvas.nodes.length + canvas.decorations.length}
          generatingCount={canvas.generatingCount}
          pointerMode={canvas.pointerMode}
          onPointerModeChange={canvas.setPointerMode}
          onZoom={handleZoom}
          onReset={canvas.resetViewport}
          canUndo={canvas.canUndo}
          canRedo={canvas.canRedo}
          onUndo={canvas.undo}
          onRedo={canvas.redo}
          filter={filter}
          onFilterChange={handleFilterChange}
          selectedCount={selectedElementCount}
          selectedResultCount={selectedResultCount}
          onCompare={() => setComparing(true)}
          onBatchExport={() => void handleBatchExport()}
          onAddFrame={() => reportOperation(t("addFrame"), () => addStructure("frame"))}
          onAddSection={() => reportOperation(t("addSection"), () => addStructure("section"))}
          onAddNote={() => reportOperation(t("addNote"), () => canvas.addDecoration("note", getSpawnPoint()))}
          onGroup={() => reportOperation(t("group"), canvas.groupSelected, selectedElementCount >= 2)}
          onUngroup={() => reportOperation(t("ungroup"), canvas.ungroupSelected, selectedElementCount > 0)}
          onLock={handleLock}
          onAlign={handleAlign}
          onLayer={handleLayer}
          onBookmark={() => reportOperation(t("bookmark"), canvas.addBookmark)}
          onProjectPanel={() => setPanel((value) => value === "projects" ? null : "projects")}
          onExportProject={handleExportProject}
          onImportProject={() => importInputRef.current?.click()}
          onTemplates={() => setPanel((value) => value === "templates" ? null : "templates")}
          onHistory={() => setPanel((value) => value === "history" ? null : "history")}
          onFit={handleFit}
          onClear={canvas.clearCanvas}
        />

        <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImportProject(file); event.currentTarget.value = ""; }} />

        {panel ? (
          <aside data-canvas-ui="panel" className="pointer-events-auto absolute left-3 top-20 z-20 w-72 rounded-2xl border border-border/70 bg-background/90 p-3 shadow-xl backdrop-blur-2xl">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{t(panel)}</h2><button type="button" aria-label={t("closePanel")} title={t("closePanel")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setPanel(null)}><X className="size-4" /></button></div>
            {panel === "projects" ? <div className="space-y-2"><input aria-label={t("projectName")} placeholder={t("projectName")} className="h-8 w-full rounded-lg border bg-transparent px-2 text-xs" value={canvas.projectName} onChange={(event) => canvas.setProjectName(event.target.value)} />{canvas.canvases.map((item) => <div key={item.id} className="flex items-center gap-2">{item.id === canvas.activeCanvasID ? <input aria-label={t("canvasName")} className="h-8 min-w-0 flex-1 rounded-lg bg-primary/10 px-2 text-xs text-primary outline-none focus:ring-1 focus:ring-primary/40" value={item.name} onChange={(event) => canvas.renameCanvas(item.id, event.target.value)} /> : <button type="button" className="flex-1 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent" onClick={() => canvas.switchCanvas(item.id)}>{item.name}</button>}<button type="button" aria-label={t("removeCanvas")} title={t("removeCanvas")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive disabled:pointer-events-none disabled:opacity-40" disabled={canvas.canvases.length <= 1} onClick={() => canvas.removeCanvas(item.id)}><Trash2 className="size-3.5" /></button></div>)}<button type="button" className="w-full rounded-lg border py-2 text-xs" onClick={() => canvas.addCanvas()}>{t("newCanvas")}</button>{canvas.bookmarks.map((item) => <div key={item.id} className="flex items-center gap-2"><button type="button" className="flex-1 rounded-lg bg-muted/50 px-2 py-2 text-left text-xs" onClick={() => canvas.goToBookmark(item.id)}>{item.name}</button><button type="button" aria-label={t("removeBookmark")} title={t("removeBookmark")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive" onClick={() => canvas.removeBookmark(item.id)}><Trash2 className="size-3.5" /></button></div>)}</div> : null}
            {panel === "templates" ? <div className="grid gap-2">{(["blank", "storyboard", "moodboard"] as const).map((item) => <button key={item} type="button" className="rounded-xl border p-3 text-left text-xs hover:bg-accent" onClick={() => { canvas.applyTemplate(item); setPanel(null); }}>{t(`template_${item}`)}</button>)}</div> : null}
            {panel === "history" ? <div className="space-y-2"><button type="button" className="w-full rounded-lg border py-2 text-xs" onClick={() => canvas.createVersion()}>{t("createVersion")}</button>{canvas.versions.map((item) => <button key={item.id} type="button" className="w-full rounded-lg bg-muted/50 px-2 py-2 text-left text-xs" onClick={() => canvas.restoreVersion(item.id)}><span className="block font-medium">{item.name}</span><span className="text-[10px] text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span></button>)}</div> : null}
          </aside>
        ) : null}

        {showStructureTip ? (
          <div data-canvas-ui="structure-tip" role="status" className="pointer-events-auto absolute left-3 top-20 z-20 max-w-xs rounded-2xl border border-primary/20 bg-background/95 p-4 shadow-xl backdrop-blur-xl">
            <button type="button" aria-label={t("dismissTip")} className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent" onClick={() => setShowStructureTip(false)}><X className="size-4" /></button>
            <p className="pr-6 text-sm font-semibold">{t("structureTipTitle")}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("structureTipDescription")}</p>
          </div>
        ) : null}

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

        {/* 右下角区域预览（资产侧边栏展开时隐藏，避免重叠） */}
        {canvas.nodes.length > 0 && assetsCollapsed ? (
          <CanvasMinimap
            nodes={canvas.nodes}
            decorations={canvas.decorations}
            viewport={canvas.viewport}
            containerSize={containerSize}
            selectedNodeIDs={canvas.selectedNodeIDs}
            onNavigate={handleMinimapNavigate}
          />
        ) : null}

        {/* 资产列表侧边栏 */}
        <CanvasAssetSidebar
          nodes={canvas.nodes}
          selectedNodeIDs={canvas.selectedNodeIDs}
          collapsed={assetsCollapsed}
          onCollapsedChange={handleAssetsCollapsedChange}
          onSelectNode={(nodeID) => canvas.setSelectedNodeIDs([nodeID])}
          onLocate={handleMinimapNavigate}
        />

        {/* 底部提示词栏 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 pt-16">
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background via-background/60 to-transparent"
            aria-hidden="true"
          />
          <CanvasPromptBar
            prompt={prompt}
            onPromptChange={setPrompt}
            references={references}
            onReferencesChange={replaceReferences}
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
        onUseAsReference={(node) => {
          handleUseAsReference(node);
          setPreviewNode(null);
        }}
        onRegenerate={(node) => {
          setPreviewNode(null);
          setRegenNode(node);
        }}
        onEdit={(node) => {
          setPreviewNode(null);
          setEditingNode(node);
        }}
        onReuseParameters={(node) => {
          handleReuseParameters(node);
          setPreviewNode(null);
        }}
        onDownload={(node) => void handleDownloadNode(node)}
      />
      <CanvasImageEditor
        node={editingNode}
        imageModels={imageModels}
        defaultModel={selectedModel}
        onClose={() => setEditingNode(null)}
        onSubmit={handleEditorSubmit}
      />
      {comparing ? <CanvasCompare nodes={selectedNodes} onClose={() => setComparing(false)} /> : null}
      {/* 编辑提示词重新生成对话框 */}
      <CanvasRegenerateDialog node={regenNode} onClose={() => setRegenNode(null)} onSubmit={handleRegenerateSubmit} />
    </div>
  );
}
