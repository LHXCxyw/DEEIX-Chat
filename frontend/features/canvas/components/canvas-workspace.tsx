"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Trash2, X } from "lucide-react";

import { toast } from "sonner";
import { useCanvasModels } from "@/features/canvas/hooks/use-canvas-models";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { useCanvasStore } from "@/features/canvas/hooks/use-canvas-store";
import { CanvasImageLightbox } from "@/features/canvas/components/canvas-image-lightbox";
import { CanvasImageEditor } from "@/features/canvas/components/canvas-image-editor";
import { CanvasAssetSidebar } from "@/features/canvas/components/canvas-asset-sidebar";
import { CanvasMinimap } from "@/features/canvas/components/canvas-minimap";
import { CanvasToolbar } from "@/features/canvas/components/canvas-toolbar";
import { CanvasViewport } from "@/features/canvas/components/canvas-viewport";
import { CanvasChatMode, type ChatTaskInput } from "@/features/canvas/components/canvas-chat-mode";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasViewport as Viewport,
  type GraphNodeKind,
  type ImageGraphNode,
  type OutputGraphNode,
} from "@/features/canvas/model/canvas-types";
import { clampViewportScale, parseCanvasState } from "@/features/canvas/model/canvas-persist";
import { editorSizeOptions } from "@/features/canvas/model/canvas-image-options";
import { fetchFileContent } from "@/shared/api/file";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

export function CanvasWorkspace() {
  const t = useTranslations("canvas");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [previewNode, setPreviewNode] = React.useState<OutputGraphNode | null>(null);
  const [editingNode, setEditingNode] = React.useState<OutputGraphNode | ImageGraphNode | null>(null);
  // 参考图节点编辑时的图源 blob 地址（编辑器关闭时回收）
  const [editingSourceURL, setEditingSourceURL] = React.useState<string | null>(null);
  const [panel, setPanel] = React.useState<"projects" | "templates" | "history" | null>(null);
  const [showStructureTip, setShowStructureTip] = React.useState(false);
  // 资产列表侧边栏折叠状态（展开时隐藏右下角小地图，避免重叠）
  const [assetsCollapsed, setAssetsCollapsed] = React.useState(false);
  const importInputRef = React.useRef<HTMLInputElement | null>(null);
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
  const canvasViewportRef = React.useRef<Viewport>({ x: 0, y: 0, scale: 1 });

  const { imageModels, modelsLoading, modelsErrorMsg } = useCanvasModels();

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

  const canvas = useCanvasStore({ getSpawnPoint });
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
    async (node: OutputGraphNode, silent = false): Promise<boolean> => {
      if (node.status !== "done" || !node.fileID) {
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

  // 输出节点 -> 参考图节点：新建携带该图的参考图节点（携带已缓存的 blob 预览），并自动连线回来源生成节点
  const handleUseAsReference = React.useCallback(
    (node: OutputGraphNode) => {
      if (node.status !== "done" || !node.fileID) {
        return;
      }
      const reference = {
        fileID: node.fileID,
        fileName: node.fileName ?? "image.png",
        mimeType: node.mimeType ?? "image/png",
        sizeBytes: node.sizeBytes ?? 0,
      };
      const imageNodeID = canvas.addGraphNode("image", {
        x: node.x,
        y: node.y + 420,
      });
      canvas.updateGraphNode(imageNodeID, {
        reference,
        previewURL: node.objectURL,
        previewLoading: !node.objectURL,
      });
      // 源输出节点被 Frame 承载时，新参考图节点继承归属且 Frame 自动扩展
      canvas.adoptNodeIntoFrame(imageNodeID, node.frameID ?? null);
      if (node.sourceGenerateID && canvas.nodes.some((item) => item.id === node.sourceGenerateID)) {
        canvas.connectGraphNodes({
          fromNodeID: imageNodeID,
          fromPort: "out",
          toNodeID: node.sourceGenerateID,
          toPort: "image",
        });
      }
      toast.success(t("referenceFromNode"));
    },
    [canvas, t],
  );

  // 参考图节点 -> 编辑器：把 fileID 解析为 blob 地址传入（避免远程 URL 污染画布导出）
  const handleEditReferenceNode = React.useCallback(
    async (node: ImageGraphNode) => {
      if (!node.reference) {
        return;
      }
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("needLogin"));
        return;
      }
      try {
        const result = await fetchFileContent(token, node.reference.fileID);
        setEditingSourceURL((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return URL.createObjectURL(result.blob);
        });
        setEditingNode(node);
      } catch {
        toast.error(t("editorLoadFailed"));
      }
    },
    [t],
  );

  // 粘贴 / 拖入图片：创建参考图节点并上传
  const attachImageFile = React.useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error(t("referenceNotImage"));
        return;
      }
      const nodeID = canvas.addGraphNode("image");
      canvas.updateGraphNode(nodeID, { uploading: true });
      const uploaded = await canvas.uploadReferenceFile(file);
      canvas.updateGraphNode(nodeID, {
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
    [canvas, t],
  );

  // 移动端对话模式：新任务节点的纵向生成位置（逐任务下移，避免重叠）
  const chatSpawnYRef = React.useRef(0);

  // 移动端发送任务：创建提示词节点 + 生成节点并连线，参考图上传后依次连线，随后立即开始生成
  const handleChatTask = React.useCallback(async ({ prompt, referenceFiles, model }: ChatTaskInput) => {
    const promptSize = { width: 288, height: 224 };
    const imageSize = { height: 264 };
    const y = chatSpawnYRef.current;
    const generateID = canvas.addGraphNode("generate", { x: promptSize.width + 64, y });
    canvas.updateGraphNode(generateID, { model: model.platformModelName });
    if (prompt) {
      const promptID = canvas.addGraphNode("prompt", { x: 0, y });
      canvas.updateGraphNode(promptID, { text: prompt });
      canvas.connectGraphNodes({ fromNodeID: promptID, fromPort: "out", toNodeID: generateID, toPort: "prompt" });
    }
    let bottom = y + promptSize.height;
    for (const file of referenceFiles) {
      const imageID = canvas.addGraphNode("image", { x: 0, y: bottom + 32 });
      canvas.updateGraphNode(imageID, { uploading: true });
      const uploaded = await canvas.uploadReferenceFile(file);
      canvas.updateGraphNode(imageID, {
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
      if (uploaded) {
        canvas.connectGraphNodes({ fromNodeID: imageID, fromPort: "out", toNodeID: generateID, toPort: "image" });
      }
      bottom += 32 + imageSize.height;
    }
    chatSpawnYRef.current = bottom + 240;
    // 切换回桌面时生成节点可见：把视口移到本任务附近由 fit 完成，这里不干预视口
    void canvas.runGenerateNode(generateID);
  }, [canvas]);

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
        (canvas.selectedNodeIDs.length > 0 || canvas.selectedDecorationIDs.length > 0 || canvas.selectedEdgeIDs.length > 0)
      ) {
        event.preventDefault();
        if (canvas.selectedEdgeIDs.length > 0) {
          for (const edgeID of canvas.selectedEdgeIDs) {
            canvas.removeEdge(edgeID);
          }
        }
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
      void attachImageFile(file);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [attachImageFile, previewNode]);

  const handleAddNode = React.useCallback(
    (kind: GraphNodeKind) => {
      canvas.addGraphNode(kind);
    },
    [canvas],
  );

  const selectedElementCount = canvas.selectedNodeIDs.length + canvas.selectedDecorationIDs.length;

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

  // 图像编辑器提交：以上传结果走图编辑管线（生成节点复用或新建）
  const handleEditorSubmit = React.useCallback(async ({ prompt, mode, image, mask, model, outputWidth, outputHeight }: { prompt: string; mode: "inpaint" | "crop" | "outpaint"; image: File; mask?: File; model: ChatModelOption; outputWidth: number; outputHeight: number }): Promise<boolean> => {
    if (!editingNode) return false;
    const source = await canvas.uploadReferenceFile(image);
    const maskReference = mask ? await canvas.uploadReferenceFile(mask) : null;
    if (!source || (mask && !maskReference)) return false;
    // 把编辑器计算出的输出尺寸同步为模型的分辨率参数，生成节点与编辑界面保持一致
    const sizeOptions = editorSizeOptions(model, outputWidth, outputHeight);
    await canvas.enqueueGraphEdit({
      sourceNodeID: editingNode.id,
      prompt,
      model,
      operation: mode,
      sizeOptions,
      sourceImage: {
        fileID: source.fileID,
        fileName: source.fileName,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
      },
      maskReference: maskReference
        ? {
          fileID: maskReference.fileID,
          fileName: maskReference.fileName,
          mimeType: maskReference.mimeType,
          sizeBytes: maskReference.sizeBytes,
        }
        : null,
    });
    return true;
  }, [canvas, editingNode]);

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
        void Promise.all(images.map(attachImageFile));
      }}
    >
      {/* 桌面端节点图（lg 及以上显示） */}
      <div className="hidden h-full min-h-0 lg:block">
        <CanvasViewport
          nodes={canvas.nodes}
        edges={canvas.edges}
        decorations={canvas.decorations}
        viewport={canvas.viewport}
        pointerMode={canvas.pointerMode}
        selectedNodeIDs={canvas.selectedNodeIDs}
        selectedDecorationIDs={canvas.selectedDecorationIDs}
        selectedEdgeIDs={canvas.selectedEdgeIDs}
        imageModels={imageModels}
        interactionLocked={previewNode !== null || editingNode !== null}
        containerSize={containerSize}
        onSelectedNodeIDsChange={canvas.setSelectedNodeIDs}
        onSelectedDecorationIDsChange={canvas.setSelectedDecorationIDs}
        onSelectedEdgeIDsChange={canvas.setSelectedEdgeIDs}
        onPointerModeChange={canvas.setPointerMode}
        onUpdateDecoration={canvas.updateDecoration}
        onMoveDecoration={canvas.moveDecoration}
        onFocusRegion={handleFocusRegion}
        onViewportChange={canvas.setViewportState}
        onBeginNodeMove={canvas.beginNodeMove}
        onMoveNodes={canvas.moveNodes}
        onEndNodeMove={canvas.endNodeMove}
        onUpdateNode={canvas.updateGraphNode}
        onEnsureNodePreview={canvas.ensureNodeImagePreview}
        onRemoveNode={canvas.removeNode}
        onRunNode={(nodeID) => void canvas.runGenerateNode(nodeID)}
        onCancelNode={canvas.cancelNode}
        onConnectNodes={canvas.connectGraphNodes}
        onRemoveEdge={canvas.removeEdge}
        onPreviewNode={setPreviewNode}
        onDownloadNode={(node) => void handleDownloadNode(node)}
        onEditNode={setEditingNode}
        onEditReferenceNode={(node) => void handleEditReferenceNode(node)}
        onUseAsReference={handleUseAsReference}
        uploadReferenceFile={canvas.uploadReferenceFile}
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
          canUndo={canvas.canUndo}
          canRedo={canvas.canRedo}
          onUndo={canvas.undo}
          onRedo={canvas.redo}
          selectedCount={selectedElementCount}
          onAddNode={handleAddNode}
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
                {modelsErrorMsg || (imageModels.length === 0 ? t("noImageModelsHint") : t("emptyHintGraph"))}
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
        </CanvasViewport>
      </div>

      {/* 移动端对话模式（lg 以下显示）：同一画布数据的对话式视图 */}
      <div className="h-full min-h-0 lg:hidden">
        <CanvasChatMode
          nodes={canvas.nodes}
          edges={canvas.edges}
          imageModels={imageModels}
          restoredModelName={canvas.restoredModelName}
          generatingCount={canvas.generatingCount}
          onRunNode={(nodeID) => void canvas.runGenerateNode(nodeID)}
          onCancelNode={canvas.cancelNode}
          onPreviewNode={setPreviewNode}
          onDownloadNode={(node) => void handleDownloadNode(node)}
          onEditNode={setEditingNode}
          onUseAsReference={handleUseAsReference}
          onAddTask={(input) => void handleChatTask(input)}
        />
      </div>

      {/* 图片放大查看 */}
      <CanvasImageLightbox
        node={previewNode}
        onClose={() => setPreviewNode(null)}
        onUseAsReference={(node) => {
          handleUseAsReference(node);
          setPreviewNode(null);
        }}
        onEdit={(node) => {
          setPreviewNode(null);
          setEditingNode(node);
        }}
        onDownload={(node) => void handleDownloadNode(node)}
      />
      <CanvasImageEditor
        node={editingNode}
        sourceURL={editingSourceURL ?? undefined}
        imageModels={imageModels}
        defaultModel={imageModels[0] ?? null}
        onClose={() => {
          setEditingNode(null);
          setEditingSourceURL((current) => {
            if (current) {
              URL.revokeObjectURL(current);
            }
            return null;
          });
        }}
        onSubmit={handleEditorSubmit}
      />
    </div>
  );
}
