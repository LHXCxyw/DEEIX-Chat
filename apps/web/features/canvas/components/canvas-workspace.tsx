"use client";

import { Scan, Settings2, Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import * as React from "react";

import { toast } from "sonner";
import { CanvasAssetSidebar } from "@/features/canvas/components/canvas-asset-sidebar";
import {
  CanvasChatComposer,
  type ChatInheritedAsset,
  type ChatInheritedContext,
  type ChatTaskInput,
} from "@/features/canvas/components/canvas-chat-composer";
import { CanvasImageEditor } from "@/features/canvas/components/canvas-image-editor";
import type { InlineEditPayload } from "@/features/canvas/components/canvas-inline-asset-editor";
import { CanvasImageLightbox } from "@/features/canvas/components/canvas-image-lightbox";
import { CanvasMediaLightbox, type CanvasMediaPreview } from "@/features/canvas/components/canvas-media-lightbox";
import { CanvasMinimap } from "@/features/canvas/components/canvas-minimap";
import { CanvasNodeInspector, type CanvasNodeInspectorHandlers } from "@/features/canvas/components/canvas-node-inspector";
import { CanvasToolbar } from "@/features/canvas/components/canvas-toolbar";
import { CanvasViewport } from "@/features/canvas/components/canvas-viewport";
import { useCanvasModels } from "@/features/canvas/hooks/use-canvas-models";
import { useCanvasStore } from "@/features/canvas/hooks/use-canvas-store";
import {
  editorSizeOptions,
  resolveCanvasImageControls,
  setOptionAtPath,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import { gatherGraphGenerateInputs } from "@/features/canvas/model/canvas-graph";
import type { CanvasAssetEntry } from "@/features/canvas/model/canvas-assets";
import type { CanvasPromptAssetKind } from "@/features/canvas/model/canvas-prompt";
import { clampViewportScale, parseCanvasState } from "@/features/canvas/model/canvas-persist";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasNodeMediaHint,
  type CanvasNodeReference,
  DEFAULT_TIMELINE_TRACKS,
  type GraphNode,
  type GraphNodeKind,
  type GenerateGraphNode,
  graphNodeSize,
  type ImageGraphNode,
  type MediaGraphNode,
  type OutputGraphNode,
  type CanvasViewport as Viewport,
} from "@/features/canvas/model/canvas-types";
import { concatTimeline, fetchFileContent, type TimelineConcatAudioSegment, type TimelineConcatSegment } from "@/shared/api/file";
import type { ConversationOptions } from "@/shared/api/conversation-types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

// 画布布局断点：与持久化的使用模式判定一致，窄屏（<1024px）走移动端对话对话框
function useCanvasCompactLayout(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(max-width: 1023px)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(max-width: 1023px)").matches,
    () => false,
  );
}

// 把解码后的音频编码为 16bit PCM WAV：用于视频「分离音频」后在画布生成音频素材
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const writeString = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

export function CanvasWorkspace() {
  const t = useTranslations("canvas");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [previewNode, setPreviewNode] = React.useState<OutputGraphNode | null>(null);
  const [editingNode, setEditingNode] = React.useState<OutputGraphNode | ImageGraphNode | null>(null);
  // 资产操作行进入编辑器时的初始模式（重绘 / 裁剪 / 扩图）
  const [editingInitialMode, setEditingInitialMode] = React.useState<"inpaint" | "crop" | "outpaint">("inpaint");
  // 参考图节点编辑时的图源 blob 地址（编辑器关闭时回收）
  const [editingSourceURL, setEditingSourceURL] = React.useState<string | null>(null);
  const [panel, setPanel] = React.useState<"projects" | "history" | null>(null);
  const [showStructureTip, setShowStructureTip] = React.useState(false);
  // 资产列表侧边栏折叠状态（展开时隐藏右下角小地图，避免重叠）
  const [assetsCollapsed, setAssetsCollapsed] = React.useState(false);
  // 资产列表的视频/音频预览（按需拉取的 blob 地址在关闭时回收）
  const [previewMedia, setPreviewMedia] = React.useState<CanvasMediaPreview | null>(null);
  const previewMediaURLRef = React.useRef<string | null>(null);
  const importInputRef = React.useRef<HTMLInputElement | null>(null);
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
  const canvasViewportRef = React.useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  // 窄屏（移动端）使用底部对话对话框；宽屏固定为节点图模式
  const compact = useCanvasCompactLayout();

  const { mediaModels, imageModels, textModels, modelsLoading, modelsErrorMsg } = useCanvasModels();

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
      // 结果已合并进生成节点：新参考节点落在来源生成节点下方，而不是已隐藏的输出节点位置
      const sourceNode = node.sourceGenerateID ? canvas.nodes.find((item) => item.id === node.sourceGenerateID) : null;
      const anchor = sourceNode ?? node;
      const imageNodeID = canvas.addGraphNode("image", {
        x: anchor.x,
        y: anchor.y + 420,
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
    async (node: ImageGraphNode | OutputGraphNode, mode: "inpaint" | "crop" | "outpaint" = "inpaint") => {
      // 参考图节点与生成结果都支持编辑：结果节点用 fileID
      const fileID = node.kind === "output" ? node.fileID : node.reference?.fileID;
      if (!fileID) {
        return;
      }
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("needLogin"));
        return;
      }
      try {
        const result = await fetchFileContent(token, fileID);
        setEditingSourceURL((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return URL.createObjectURL(result.blob);
        });
        // 把画布定位到素材节点居中；生成结果按父生成卡片居中
        const anchor = node.kind === "output" && node.sourceGenerateID
          ? canvas.nodes.find((item) => item.id === node.sourceGenerateID) ?? node
          : node;
        const nodeSize = graphNodeSize(anchor);
        const scale = canvas.viewport.scale;
        canvas.setViewportState({
          ...canvas.viewport,
          x: containerSize.width / 2 - (anchor.x + nodeSize.width / 2) * scale,
          y: containerSize.height / 2 - (anchor.y + nodeSize.height / 2) * scale,
        });
        setEditingInitialMode(mode);
        setEditingNode(node);
      } catch {
        toast.error(t("editorLoadFailed"));
      }
    },
    [canvas, containerSize.height, containerSize.width, t],
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

  // 继承状态与「当前选中」解耦：点击空白取消选择时继承仍然保留，
  // 只有选中另一个生成节点才切换目标，或在继承条上点 × 主动解除。
  const [inheritedGenerateID, setInheritedGenerateID] = React.useState<string | null>(null);
  // 主动解除继承时记录当时的选中节点，避免同一选中在节点更新时被重新继承
  const dismissedInheritSelectionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (canvas.selectedNodeIDs.length !== 1) {
      dismissedInheritSelectionRef.current = null;
      return;
    }
    const selectedID = canvas.selectedNodeIDs[0];
    if (dismissedInheritSelectionRef.current === selectedID) {
      return;
    }
    // 选中已切换到其他节点：解除记录失效，允许重新继承
    dismissedInheritSelectionRef.current = null;
    const selected = canvas.nodes.find((node) => node.id === selectedID);
    const sourceID = selected?.kind === "generate"
      ? selected.id
      : selected?.kind === "output" ? selected.sourceGenerateID ?? null : null;
    const source = sourceID ? canvas.nodes.find((node) => node.id === sourceID) : null;
    if (source?.kind === "generate") {
      setInheritedGenerateID(source.id);
    }
  }, [canvas.nodes, canvas.selectedNodeIDs]);

  const handleClearInheritance = React.useCallback(() => {
    dismissedInheritSelectionRef.current = canvas.selectedNodeIDs[0] ?? null;
    setInheritedGenerateID(null);
  }, [canvas.selectedNodeIDs]);

  // 被继承的生成节点被删除后自动解除继承
  React.useEffect(() => {
    if (!inheritedGenerateID) {
      return;
    }
    if (!canvas.nodes.some((node) => node.id === inheritedGenerateID && node.kind === "generate")) {
      setInheritedGenerateID(null);
    }
  }, [canvas.nodes, inheritedGenerateID]);

  // 对话模式继承：被继承的生成节点把模型、参数与上游素材带入输入条，
  // 发送时直接在该节点上发起任务，不再新建工作流
  const inheritedContext = React.useMemo<ChatInheritedContext | null>(() => {
    if (!inheritedGenerateID) {
      return null;
    }
    const node = canvas.nodes.find((item) => item.id === inheritedGenerateID);
    if (node?.kind !== "generate") {
      return null;
    }
    const inputs = gatherGraphGenerateInputs(node.id, canvas.nodes, canvas.edges);
    const assets: ChatInheritedAsset[] = [
      ...inputs.references.map((item, index) => ({
        fileID: item.fileID,
        fileName: item.fileName,
        kind: "image" as const,
        sourceNodeID: inputs.referenceSourceIDs[index] ?? "",
        port: "image" as const,
      })),
      ...inputs.videoReferences.map((item, index) => ({
        fileID: item.fileID,
        fileName: item.fileName,
        kind: "video" as const,
        sourceNodeID: inputs.videoReferenceSourceIDs[index] ?? "",
        port: "video" as const,
      })),
      ...inputs.audioReferences.map((item, index) => ({
        fileID: item.fileID,
        fileName: item.fileName,
        kind: "audio" as const,
        sourceNodeID: inputs.audioReferenceSourceIDs[index] ?? "",
        port: "audio" as const,
      })),
    ];
    return { node, prompt: node.prompt?.trim() || inputs.prompt, assets };
  }, [canvas.edges, canvas.nodes, inheritedGenerateID]);

  // 取消单个继承素材：断开该素材与生成节点的连线，素材节点本身保留在画布上
  const handleRemoveInheritedAsset = React.useCallback((asset: ChatInheritedAsset) => {
    if (!inheritedGenerateID) {
      return;
    }
    const edge = canvas.edges.find((item) =>
      item.toNodeID === inheritedGenerateID
      && item.fromNodeID === asset.sourceNodeID
      && item.toPort === asset.port);
    if (edge) {
      canvas.removeEdge(edge.id);
    }
  }, [canvas, inheritedGenerateID]);

  const closeMediaPreview = React.useCallback(() => {
    setPreviewMedia(null);
    if (previewMediaURLRef.current) {
      URL.revokeObjectURL(previewMediaURLRef.current);
      previewMediaURLRef.current = null;
    }
  }, []);

  // 资产列表的视频/音频预览：优先用节点已缓存的 blob，缺失时按 fileID 拉取
  const handlePreviewMedia = React.useCallback(async (node: GraphNode) => {
    const kind: "video" | "audio" | null = node.kind === "output"
      ? (node.mediaType === "video" || node.mimeType?.startsWith("video/") ? "video" : "audio")
      : node.kind === "media" ? node.mediaKind : null;
    if (!kind) {
      return;
    }
    const fileName = node.kind === "output"
      ? node.fileName ?? ""
      : node.kind === "media" ? node.reference?.fileName ?? "" : "";
    const cachedSource = node.kind === "output" ? node.objectURL : node.kind === "media" ? node.previewURL : undefined;
    if (cachedSource) {
      setPreviewMedia({ source: cachedSource, fileName, kind });
      return;
    }
    const fileID = node.kind === "output" ? node.fileID : node.kind === "media" ? node.reference?.fileID : undefined;
    if (!fileID) {
      return;
    }
    const token = await resolveAccessToken();
    if (!token) {
      toast.error(t("needLogin"));
      return;
    }
    try {
      const result = await fetchFileContent(token, fileID);
      const objectURL = URL.createObjectURL(result.blob);
      previewMediaURLRef.current = objectURL;
      setPreviewMedia({ source: objectURL, fileName, kind });
    } catch {
      toast.error(t("downloadFailed"));
    }
  }, [t]);

  // 对话输入条发送任务：
  // - 继承生成节点：只更新该节点的模型/参数，新增参考图接到该节点，随后直接发起生成；
  // - 未继承：在视口中心创建新的生成节点与提示词/参考图节点，组成一套新工作流。
  const handleChatTask = React.useCallback(async ({ prompt, referenceFiles, model, options, resultCount, inheritedGenerateNodeID }: ChatTaskInput) => {
    const mediaType = model.kinds.includes("video_gen") ? "video" : "image";
    const promptSize = { width: 288, height: 224 };
    const generateSize = { width: 336, height: 512 };
    const imageSize = { height: 264 };
    const base = getSpawnPoint();
    const modelPatch = {
      model: model.platformModelName,
      modelScope: model.modelScope === "user" ? "user" as const : "platform" as const,
      userModelID: model.modelScope === "user" ? model.userModelID : undefined,
    };

    const inheritedTarget = inheritedGenerateNodeID
      ? canvas.nodes.find((node) => node.id === inheritedGenerateNodeID)
      : null;
    if (inheritedTarget && inheritedTarget.kind === "generate") {
      canvas.updateGraphNode(inheritedTarget.id, { ...modelPatch, mediaType, options, resultCount });
      // 新增参考图：作为参考图节点接到被继承的生成节点，不新建生成工作流
      const leftX = Math.round(inheritedTarget.x - 288 - 64);
      let top = inheritedTarget.y;
      for (const file of referenceFiles) {
        const imageID = canvas.addGraphNode("image", { x: leftX, y: top });
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
          canvas.connectGraphNodes({ fromNodeID: imageID, fromPort: "out", toNodeID: inheritedTarget.id, toPort: "image" });
        }
        top += imageSize.height + 32;
      }
      void canvas.runGenerateNode(inheritedTarget.id, { prompt: prompt || undefined });
      return;
    }

    const generateX = Math.round(base.x - generateSize.width / 2);
    const generateY = Math.round(base.y - generateSize.height / 2);
    const leftX = Math.round(generateX - promptSize.width - 64);
    const generateID = canvas.addGraphNode("generate", { x: generateX, y: generateY }, mediaType);
    // 提示词与参数绑定在生成节点内，不再创建独立提示词节点
    canvas.updateGraphNode(generateID, { ...modelPatch, options, resultCount, prompt: prompt || "" });
    let bottom = generateY;
    for (const file of referenceFiles) {
      const imageID = canvas.addGraphNode("image", { x: leftX, y: bottom + promptSize.height + 32 });
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
      bottom += imageSize.height + 32;
    }
    void canvas.runGenerateNode(generateID);
  }, [canvas, getSpawnPoint]);

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
    (kind: GraphNodeKind, mediaType?: CanvasNodeMediaHint) => {
      canvas.addGraphNode(kind, undefined, mediaType);
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

  const handleLock = React.useCallback(() => {
    const selected = [
      ...canvas.nodes.filter((item) => canvas.selectedNodeIDs.includes(item.id)),
      ...canvas.decorations.filter((item) => canvas.selectedDecorationIDs.includes(item.id)),
    ];
    const locking = selected.some((item) => !item.locked);
    reportOperation(locking ? t("lockSelected") : t("unlockSelected"), canvas.toggleLockSelected, selected.length > 0);
  }, [canvas, reportOperation, t]);

  // 图像编辑器提交：以上传结果走图编辑管线（生成节点复用或新建）
  const handleEditorSubmit = React.useCallback(async ({ prompt, mode, image, mask, model, outputWidth, outputHeight }: { prompt: string; mode: "inpaint" | "crop" | "outpaint"; image: File; mask?: File; model: CanvasModelOption; outputWidth: number; outputHeight: number }): Promise<boolean> => {
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
      // 素材操作一律新建生成节点：结果独立成卡并自动连回素材
      forceNewNode: true,
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

  // 组表头自动排版：素材类在左、生成类在右；同类节点成排均匀铺开
  const handleArrangeFrame = React.useCallback((frameID: string) => {
    const frame = canvas.decorations.find((item) => item.id === frameID && item.kind === "frame");
    if (!frame) {
      return;
    }
    const members = canvas.nodes.filter((node) => node.frameID === frameID && node.kind !== "output");
    if (members.length === 0) {
      return;
    }
    // 生成类节点（生成 / 时间线）放右侧，其余素材类放左侧
    const isGenerated = (node: GraphNode) => node.kind === "generate" || node.kind === "timeline";
    const typeKeyOf = (node: GraphNode) => {
      if (node.kind === "media") {
        return `media:${node.mediaKind ?? "video"}`;
      }
      if (node.kind === "generate") {
        return `generate:${node.mediaType ?? "image"}`;
      }
      return node.kind;
    };
    const groupsByZone = (zone: "material" | "generated") => {
      const groups = new Map<string, GraphNode[]>();
      for (const node of members.filter((item) => (zone === "generated" ? isGenerated(item) : !isGenerated(item)))) {
        const key = typeKeyOf(node);
        groups.set(key, [...(groups.get(key) ?? []), node]);
      }
      return [...groups.values()]
        .map((list) => [...list].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)))
        .sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x || a[0].id.localeCompare(b[0].id));
    };

    const cellGap = 24;
    const rowGap = 40;
    const zoneGap = 120;
    const top = frame.y + 88;
    const positions: { nodeID: string; x: number; y: number }[] = [];
    const gapColumns = (count: number): number => {
      // 1~3 个一行排开；更多时按两行均分，多出来的一个并入第一行（9 个 -> 5+4）
      return count <= 3 ? count : Math.ceil(count / 2);
    };
    const layoutZone = (zone: "material" | "generated", originX: number) => {
      let cursorY = top;
      let zoneWidth = 0;
      for (const list of groupsByZone(zone)) {
        const columns = gapColumns(list.length);
        const cellWidth = Math.max(...list.map((node) => graphNodeSize(node).width));
        const cellHeight = Math.max(...list.map((node) => graphNodeSize(node).height));
        list.forEach((node, index) => {
          const row = Math.floor(index / columns);
          const column = index % columns;
          positions.push({
            nodeID: node.id,
            x: Math.round(originX + column * (cellWidth + cellGap)),
            y: Math.round(cursorY + row * (cellHeight + rowGap)),
          });
        });
        const rows = Math.ceil(list.length / columns);
        zoneWidth = Math.max(zoneWidth, columns * cellWidth + (columns - 1) * cellGap);
        cursorY += rows * cellHeight + (rows - 1) * rowGap + rowGap;
      }
      return zoneWidth;
    };

    const leftWidth = layoutZone("material", frame.x + 48);
    const materialGroups = groupsByZone("material").length;
    layoutZone("generated", frame.x + 48 + (materialGroups > 0 ? leftWidth + zoneGap : 0));

    canvas.beginNodeMove();
    canvas.moveNodes(positions);
    canvas.endNodeMove();

    // 排版后自动扩展 Frame，保证所有节点都被组包裹
    const padding = 48;
    const bounds = positions.reduce((box, item) => {
      const node = members.find((entry) => entry.id === item.nodeID);
      const size = node ? graphNodeSize(node) : { width: 0, height: 0 };
      return {
        left: Math.min(box.left, item.x),
        top: Math.min(box.top, item.y),
        right: Math.max(box.right, item.x + size.width),
        bottom: Math.max(box.bottom, item.y + size.height),
      };
    }, { left: frame.x + frame.width, top: frame.y + frame.height, right: frame.x, bottom: frame.y });
    const nextX = Math.min(frame.x, bounds.left - padding);
    const nextY = Math.min(frame.y, bounds.top - padding);
    const nextRight = Math.max(frame.x + frame.width, bounds.right + padding);
    const nextBottom = Math.max(frame.y + frame.height, bounds.bottom + padding);
    canvas.updateDecoration(frameID, {
      x: nextX,
      y: nextY,
      width: nextRight - nextX,
      height: nextBottom - nextY,
    });
    toast.success(t("frameAutoLayout"));
  }, [canvas, t]);

  const showEmptyState = canvas.restored && canvas.nodes.length === 0 && canvas.decorations.length === 0 && !modelsLoading;
  const addStructure = React.useCallback((kind: "frame" | "note") => {
    // 已有选中节点 / 装饰时，新建组自动包裹选中范围；否则在视图中心放置
    if (kind === "frame" && canvas.frameSelection()) {
      return;
    }
    canvas.addDecoration(kind, getSpawnPoint());
    if (kind === "frame" && typeof window !== "undefined" && window.localStorage.getItem("deeix-canvas-structure-tip") !== "seen") {
      setShowStructureTip(true);
      window.localStorage.setItem("deeix-canvas-structure-tip", "seen");
    }
  }, [canvas, getSpawnPoint]);

  // 合并节点的结果预览：图像走灯箱，视频 / 音频走媒体预览
  const handlePreviewResult = React.useCallback(async (node: OutputGraphNode) => {
    if (!node.fileID) {
      return;
    }
    const kind = node.mediaType === "video" || node.mimeType?.startsWith("video/") ? "video" : "image";
    if (kind === "image") {
      setPreviewNode(node);
      return;
    }
    if (node.objectURL) {
      setPreviewMedia({ source: node.objectURL, fileName: node.fileName ?? "", kind });
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
      previewMediaURLRef.current = objectURL;
      setPreviewMedia({ source: objectURL, fileName: node.fileName ?? "", kind });
    } catch {
      toast.error(t("downloadFailed"));
    }
  }, [t]);

  // 对话框内 @ 素材预览：图像复用图片灯箱，视频 / 音频复用媒体预览
  const handlePreviewAsset = React.useCallback(async (asset: CanvasAssetEntry) => {
    const reference = asset.reference;
    if (asset.previewURL) {
      if (asset.kind === "image") {
        setPreviewNode({
          id: asset.sourceNodeID, kind: "output", x: 0, y: 0, createdAt: 0,
          mediaType: "image", status: "done",
          fileID: reference.fileID, fileName: reference.fileName, mimeType: reference.mimeType,
          sizeBytes: reference.sizeBytes, objectURL: asset.previewURL,
        });
      } else {
        setPreviewMedia({ source: asset.previewURL, fileName: reference.fileName, kind: asset.kind === "video" ? "video" : "audio" });
      }
      return;
    }
    const token = await resolveAccessToken();
    if (!token) {
      toast.error(t("needLogin"));
      return;
    }
    try {
      const result = await fetchFileContent(token, reference.fileID);
      const objectURL = URL.createObjectURL(result.blob);
      if (asset.kind === "image") {
        setPreviewNode({
          id: asset.sourceNodeID, kind: "output", x: 0, y: 0, createdAt: 0,
          mediaType: "image", status: "done",
          fileID: reference.fileID, fileName: reference.fileName, mimeType: reference.mimeType,
          sizeBytes: reference.sizeBytes, objectURL,
        });
      } else {
        previewMediaURLRef.current = objectURL;
        setPreviewMedia({ source: objectURL, fileName: reference.fileName, kind: asset.kind === "video" ? "video" : "audio" });
      }
    } catch {
      toast.error(t("downloadFailed"));
    }
  }, [t]);

  // 对话框添加素材：复用已有素材节点或新建素材节点，并连线到生成节点
  const handleAttachAsset = React.useCallback((
    nodeID: string,
    reference: CanvasNodeReference,
    kind: CanvasPromptAssetKind,
    previewURL?: string,
  ) => {
    const target = canvas.nodes.find((node) => node.id === nodeID);
    if (!target || target.kind !== "generate") {
      return;
    }
    const toPort = kind === "audio" ? "audio" : kind === "video" ? "video" : "image";
    // 参考视频 / 音频端口只存在于视频生成节点
    if (toPort !== "image" && target.mediaType !== "video") {
      return;
    }
    // 复用画布上已有的同文件素材节点；生成结果则回退到来源生成节点
    const existing = canvas.nodes.find((node) =>
      (node.kind === "image" || node.kind === "media") && node.reference?.fileID === reference.fileID)
      ?? canvas.nodes.find((node) => node.kind === "output" && node.fileID === reference.fileID);
    let sourceID = existing?.id;
    if (existing?.kind === "output" && existing.sourceGenerateID) {
      sourceID = existing.sourceGenerateID;
    }
    if (!sourceID) {
      const x = Math.round(target.x - 340);
      const y = Math.round(target.y + 16);
      if (kind === "video" || kind === "audio") {
        sourceID = canvas.addGraphNode("media", { x, y }, kind);
      } else {
        sourceID = canvas.addGraphNode("image", { x, y });
      }
      canvas.updateGraphNode(sourceID, { reference, previewURL });
    }
    canvas.connectGraphNodes({ fromNodeID: sourceID, fromPort: "out", toNodeID: nodeID, toPort });
  }, [canvas]);

  // 素材悬浮工具栏：超清。按 2K/4K 预设创建新生成节点，自动连入参考图并立即运行
  const handleUpscaleAsset = React.useCallback(async (node: ImageGraphNode | OutputGraphNode, tier: "2K" | "4K", model: CanvasModelOption) => {
    // 参考图节点与图片结果都可作为超清来源
    const fileID = node.kind === "output" ? node.fileID : node.reference?.fileID;
    if (!fileID) {
      return;
    }
    const previewURL = node.kind === "output" ? node.objectURL ?? node.previewURL : node.previewURL;
    const base = tier === "4K" ? 2880 : 2048;
    // 读取源图比例，按长边等于目标档位计算输出尺寸
    let width = base;
    let height = base;
    if (previewURL) {
      const dims = await new Promise<{ width: number; height: number } | null>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve(null);
        image.src = previewURL;
      });
      if (dims && dims.width > 0 && dims.height > 0) {
        const scale = base / Math.max(dims.width, dims.height);
        width = Math.round(dims.width * scale);
        height = Math.round(dims.height * scale);
      }
    }
    const controls = resolveCanvasImageControls(model);
    const sizeControl = controls.find((control) => control.path === "size");
    const resolutionControl = controls.find((control) => /(?:^|\.)(imageSize|image_size|resolution)$/.test(control.path));
    let options: ConversationOptions = {};
    if (sizeControl) {
      // OpenAI 类：size 就是宽高像素组合
      options = setOptionAtPath(options, ["size"], `${width}x${height}`);
    } else if (resolutionControl) {
      // Gemini 类：只接收 1K/2K/4K 档位
      options = setOptionAtPath(options, resolutionControl.path.split("."), tier);
    }
    const generateID = canvas.addGraphNode("generate", { x: node.x + 340, y: node.y }, "image");
    canvas.updateGraphNode(generateID, {
      model: model.platformModelName,
      modelScope: model.modelScope === "user" ? "user" : "platform",
      userModelID: model.modelScope === "user" ? model.userModelID : undefined,
      mediaType: "image",
      prompt: `${tier} 超清放大，保持原始构图与内容不变，补充清晰细节、锐利边缘与自然质感`,
      options,
      resultCount: 1,
    });
    canvas.connectGraphNodes({ fromNodeID: node.id, fromPort: "out", toNodeID: generateID, toPort: "image" });
    void canvas.runGenerateNode(generateID);
  }, [canvas]);

  // 画布内联素材编辑：上传裁剪/蒙版结果并创建生成节点
  const handleSubmitAssetEdit = React.useCallback(async (nodeID: string, payload: InlineEditPayload): Promise<boolean> => {
    const source = canvas.nodes.find((item) => item.id === nodeID);
    if (!source || (source.kind !== "image" && source.kind !== "output")) {
      return false;
    }
    const uploaded = await canvas.uploadReferenceFile(payload.image);
    const maskUploaded = payload.mask ? await canvas.uploadReferenceFile(payload.mask) : null;
    if (!uploaded || (payload.mask && !maskUploaded)) {
      return false;
    }
    await canvas.enqueueGraphEdit({
      sourceNodeID: nodeID,
      prompt: payload.prompt,
      model: payload.model,
      operation: payload.mode,
      sizeOptions: editorSizeOptions(payload.model, payload.outputWidth, payload.outputHeight),
      sourceImage: {
        fileID: uploaded.fileID,
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
      },
      maskReference: maskUploaded
        ? {
          fileID: maskUploaded.fileID,
          fileName: maskUploaded.fileName,
          mimeType: maskUploaded.mimeType,
          sizeBytes: maskUploaded.sizeBytes,
        }
        : null,
      forceNewNode: true,
    });
    return true;
  }, [canvas]);

  // 时间线导出：把片段列表交给后端 ffmpeg 裁剪拼接，产物落为新的视频素材节点
  const handleExportTimeline = React.useCallback(async (nodeID: string) => {
    const node = canvas.nodes.find((item) => item.id === nodeID);
    if (node?.kind !== "timeline" || node.segments.length === 0) {
      return;
    }
    const resolveSourceFileID = (sourceNodeID: string): string | null => {
      const source = canvas.nodes.find((item) => item.id === sourceNodeID);
      if (!source) {
        return null;
      }
      if (source.kind === "media" || source.kind === "image") {
        return source.reference?.fileID ?? null;
      }
      if (source.kind === "output") {
        return source.fileID ?? null;
      }
      if (source.kind === "generate") {
        // 生成结果保存在输出子节点，导出时取其已完成的产物
        const result = canvas.nodes.find(
          (item) => item.kind === "output" && item.sourceGenerateID === source.id && item.fileID,
        );
        return result?.kind === "output" ? result.fileID ?? null : null;
      }
      return null;
    };
    const segments: TimelineConcatSegment[] = [];
    // 按时间线位置排序后再拼接（拖动过的片段以 timelineStart 为准）
    const orderedSegments = [...node.segments].sort((a, b) => (a.timelineStart ?? 0) - (b.timelineStart ?? 0));
    for (const segment of orderedSegments) {
      // 导出只取视频轨；音频轨用于画布内同步预览
      if ((segment.track ?? "video") !== "video") {
        continue;
      }
      const fileID = resolveSourceFileID(segment.sourceNodeID);
      if (!fileID) {
        continue;
      }
      segments.push(segment.end > segment.start
        ? { fileID, start: segment.start, end: segment.end }
        : { fileID });
    }
    if (segments.length === 0) {
      toast.error(t("timelineExportFailed"));
      return;
    }
    // 独立音频轨：一并送去后端混音，避免导出的成片没有声音
    const tracks = node.tracks && node.tracks.length > 0 ? node.tracks : DEFAULT_TIMELINE_TRACKS;
    const audioTrackIDs = new Set(tracks.filter((track) => track.kind === "audio").map((track) => track.id));
    const audioSegments: TimelineConcatAudioSegment[] = [];
    for (const segment of [...node.segments].sort((a, b) => (a.timelineStart ?? 0) - (b.timelineStart ?? 0))) {
      if (!audioTrackIDs.has(segment.track ?? "video")) {
        continue;
      }
      const fileID = resolveSourceFileID(segment.sourceNodeID);
      if (!fileID) {
        continue;
      }
      audioSegments.push({
        fileID,
        ...(segment.end > segment.start ? { start: segment.start, end: segment.end } : {}),
        ...(segment.timelineStart === undefined ? {} : { timelineStart: segment.timelineStart }),
      });
    }
    const token = await resolveAccessToken();
    if (!token) {
      toast.error(t("needLogin"));
      return;
    }
    canvas.updateGraphNode(nodeID, { exporting: true, exportError: undefined });
    try {
      const result = await concatTimeline(token, segments, audioSegments);
      // 拉取产物生成预览地址：视频节点可直接播放，无需再次请求
      const content = await fetchFileContent(token, result.fileID);
      const previewURL = URL.createObjectURL(content.blob);
      const mediaID = canvas.addGraphNode("media", { x: node.x + 480, y: node.y }, "video");
      canvas.updateGraphNode(mediaID, {
        reference: {
          fileID: result.fileID,
          fileName: result.fileName,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
        },
        previewURL,
      });
      canvas.updateGraphNode(nodeID, { exporting: false, exportError: undefined });
      toast.success(t("timelineExportDone"));
    } catch (error) {
      canvas.updateGraphNode(nodeID, {
        exporting: false,
        exportError: error instanceof Error ? error.message : t("timelineExportFailed"),
      });
      toast.error(t("timelineExportFailed"));
    }
  }, [canvas, t]);

  // 视频截帧：按首帧 / 尾帧 / 指定秒数取帧，绘制到画布并上传，生成图片素材节点
  const handleExtractFrame = React.useCallback(async (
    node: MediaGraphNode | OutputGraphNode,
    frame?: "first" | "last" | number,
  ) => {
    const source = node.kind === "output" ? node.objectURL ?? node.previewURL : node.previewURL;
    const sourceName = node.kind === "output" ? node.fileName : node.reference?.fileName;
    if (!source) {
      toast.error(t("extractFrameFailed"));
      return;
    }
    try {
      const video = document.createElement("video");
      video.src = source;
      video.muted = true;
      video.preload = "auto";
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("video load failed"));
      });
      const total = Number.isFinite(video.duration) ? video.duration : 0;
      const at = typeof frame === "number"
        ? Math.min(Math.max(0, frame), Math.max(0, total - 0.05))
        : frame === "last"
          ? Math.max(0, total - 0.1)
          : Math.min(0.1, Math.max(0, total / 2));
      video.currentTime = at;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
      });
      const canvasElement = document.createElement("canvas");
      canvasElement.width = video.videoWidth;
      canvasElement.height = video.videoHeight;
      canvasElement.getContext("2d")?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvasElement.toBlob(resolve, "image/png");
      });
      if (!blob) {
        throw new Error("frame encode failed");
      }
      const file = new File([blob], `${sourceName ?? "frame"}-frame.png`, { type: "image/png" });
      const uploaded = await canvas.uploadReferenceFile(file);
      if (!uploaded) {
        throw new Error("upload failed");
      }
      const imageID = canvas.addGraphNode("image", { x: node.x, y: node.y + 300 });
      canvas.updateGraphNode(imageID, {
        reference: {
          fileID: uploaded.fileID,
          fileName: uploaded.fileName,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
        },
        previewURL: uploaded.previewURL,
      });
      toast.success(t("extractFrameDone"));
    } catch {
      toast.error(t("extractFrameFailed"));
    }
  }, [canvas, t]);

  // 分离音频：解码视频音轨并编码为 WAV，生成音频素材节点
  const handleExtractAudio = React.useCallback(async (node: MediaGraphNode | OutputGraphNode) => {
    const source = node.kind === "output" ? node.objectURL ?? node.previewURL : node.previewURL;
    const sourceName = node.kind === "output" ? node.fileName : node.reference?.fileName;
    if (!source) {
      toast.error(t("extractAudioFailed"));
      return;
    }
    try {
      const response = await fetch(source);
      const buffer = await response.arrayBuffer();
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(buffer);
      void context.close();
      const wav = audioBufferToWav(decoded);
      const file = new File([wav], `${sourceName ?? "audio"}-audio.wav`, { type: "audio/wav" });
      const uploaded = await canvas.uploadReferenceFile(file);
      if (!uploaded) {
        throw new Error("upload failed");
      }
      const audioID = canvas.addGraphNode("media", { x: node.x, y: node.y + 300 }, "audio");
      canvas.updateGraphNode(audioID, {
        reference: {
          fileID: uploaded.fileID,
          fileName: uploaded.fileName,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
        },
        previewURL: uploaded.previewURL,
      });
      toast.success(t("extractAudioDone"));
    } catch {
      toast.error(t("extractAudioFailed"));
    }
  }, [canvas, t]);

  // 外部文件拖入画布：图片落为参考图节点，视频/音频落为媒体节点
  const handleImportFiles = React.useCallback(async (files: File[], point: { x: number; y: number }) => {
    let imported = 0;
    let offset = 0;
    for (const file of files) {
      const mime = file.type ?? "";
      const isImage = mime.startsWith("image/");
      const isVideo = mime.startsWith("video/");
      const isAudio = mime.startsWith("audio/");
      if (!isImage && !isVideo && !isAudio) {
        continue;
      }
      const uploaded = await canvas.uploadReferenceFile(file);
      if (!uploaded) {
        continue;
      }
      // 多文件按 / 斜向错位摆放，避免完全重叠
      const position = { x: point.x + offset * 28, y: point.y + offset * 28 };
      const nodeID = isImage
        ? canvas.addGraphNode("image", position)
        : canvas.addGraphNode("media", position, isAudio ? "audio" : "video");
      canvas.updateGraphNode(nodeID, {
        reference: {
          fileID: uploaded.fileID,
          fileName: uploaded.fileName,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
        },
        previewURL: uploaded.previewURL,
      });
      imported += 1;
      offset += 1;
    }
    if (imported > 0) {
      toast.success(t("dropImportDone", { count: imported }));
      return;
    }
    toast.error(t("dropImportUnsupported"));
  }, [canvas, t]);

  // 移动端：选中的生成节点直接填充底部对话框（不弹悬浮面板），样式与操作与节点图一致
  const selectedGenerateNode = React.useMemo<GenerateGraphNode | null>(() => {
    if (!compact || canvas.selectedNodeIDs.length !== 1) {
      return null;
    }
    const selected = canvas.nodes.find((item) => item.id === canvas.selectedNodeIDs[0]);
    if (!selected) {
      return null;
    }
    if (selected.kind === "generate") {
      return selected;
    }
    if (selected.kind === "output" && selected.sourceGenerateID) {
      const source = canvas.nodes.find((item) => item.id === selected.sourceGenerateID);
      return source?.kind === "generate" ? source : null;
    }
    return null;
  }, [canvas.nodes, canvas.selectedNodeIDs, compact]);

  const mobileInspectorHandlers = React.useMemo<CanvasNodeInspectorHandlers>(() => ({
    onUpdateNode: canvas.updateGraphNode,
    onRunNode: (nodeID) => void canvas.runGenerateNode(nodeID),
    onRemoveEdge: canvas.removeEdge,
    onPreviewAsset: (asset) => void handlePreviewAsset(asset),
    onAttachAsset: handleAttachAsset,
    uploadReferenceFile: canvas.uploadReferenceFile,
    // 关闭对话框同时解除继承，避免下次打开输入条继续沿用该节点
    onClose: () => {
      handleClearInheritance();
      canvas.setSelectedNodeIDs([]);
    },
  }), [canvas, handleAttachAsset, handleClearInheritance, handlePreviewAsset]);

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
      {/* 无限画布：桌面与移动端共用，移动端通过底部输入条发送任务 */}
      <CanvasViewport
        nodes={canvas.nodes}
        edges={canvas.edges}
        decorations={canvas.decorations}
        viewport={canvas.viewport}
        pointerMode={canvas.pointerMode}
        selectedNodeIDs={canvas.selectedNodeIDs}
        selectedDecorationIDs={canvas.selectedDecorationIDs}
        selectedEdgeIDs={canvas.selectedEdgeIDs}
        imageModels={mediaModels}
        showInspector={!compact}
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
        onRequeryNode={(nodeID) => void canvas.requeryGenerateNode(nodeID)}
        onRequeryOutputNode={(nodeID) => void canvas.requeryOutputNode(nodeID)}
        onRetryOutputSave={(nodeID) => void canvas.retryOutputNodeSave(nodeID)}
        onConnectNodes={canvas.connectGraphNodes}
        onDropConnection={canvas.connectToNewNode}
        onRemoveEdge={canvas.removeEdge}
        onPreviewNode={setPreviewNode}
        onPreviewResult={(node) => void handlePreviewResult(node)}
        onDuplicateNodes={canvas.duplicateNodes}
        onCopyNodes={(nodeIDs) => {
          const count = canvas.copySelectedNodes(nodeIDs);
          if (count > 0) {
            toast.success(t("copyNodesDone", { count }));
          }
        }}
        onPasteNodes={(point) => {
          const count = canvas.pasteCopiedNodes(point);
          if (count > 0) {
            toast.success(t("pasteNodesDone", { count }));
          } else {
            toast.error(t("pasteNodesEmpty"));
          }
        }}
        canPasteNodes={canvas.hasCopiedNodes()}
        onPreviewAsset={(asset) => void handlePreviewAsset(asset)}
        onAttachAsset={handleAttachAsset}
        onUndo={canvas.undo}
        onRedo={canvas.redo}
        canUndo={canvas.canUndo}
        canRedo={canvas.canRedo}
        onRemoveSelected={canvas.removeSelected}
        onAddDecoration={addStructure}
        onArrangeFrame={handleArrangeFrame}
        onDownloadNode={(node) => void handleDownloadNode(node)}
        onEditNode={(node) => {
          setEditingInitialMode("inpaint");
          setEditingNode(node);
        }}
        onEditReferenceNode={(node, mode) => void handleEditReferenceNode(node, mode)}
        onUpscaleAsset={(node, tier, model) => void handleUpscaleAsset(node, tier, model)}
        onExtractFrame={(node, frame) => void handleExtractFrame(node, frame)}
        onExtractAudio={(node) => void handleExtractAudio(node)}
        onExportTimeline={(nodeID) => void handleExportTimeline(nodeID)}
        onSubmitAssetEdit={handleSubmitAssetEdit}
        onUseAsReference={handleUseAsReference}
        onImportFiles={(files, point) => void handleImportFiles(files, point)}
        uploadReferenceFile={canvas.uploadReferenceFile}
      >
        {/* 顶部工具栏 */}
        <CanvasToolbar
          viewport={canvas.viewport}
          nodeCount={canvas.nodes.filter((node) => node.kind !== "output").length}
          generatingCount={canvas.generatingCount}
          pointerMode={canvas.pointerMode}
          onPointerModeChange={canvas.setPointerMode}
          onZoom={handleZoom}
          onReset={handleFit}
          canUndo={canvas.canUndo}
          canRedo={canvas.canRedo}
          onUndo={canvas.undo}
          onRedo={canvas.redo}
          selectedCount={selectedElementCount}
          onAddNode={handleAddNode}
          onAddFrame={() => reportOperation(t("addFrame"), () => addStructure("frame"))}
          onAddNote={() => reportOperation(t("addNote"), () => canvas.addDecoration("note", getSpawnPoint()))}
          onLock={handleLock}
          onBookmark={() => reportOperation(t("bookmark"), canvas.addBookmark)}
          onProjectPanel={() => setPanel((value) => value === "projects" ? null : "projects")}
          onExportProject={handleExportProject}
          onImportProject={() => importInputRef.current?.click()}
          onHistory={() => setPanel((value) => value === "history" ? null : "history")}
          onFit={handleFit}
          onClear={canvas.clearCanvas}
          textModels={textModels}
        />

        <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImportProject(file); event.currentTarget.value = ""; }} />

        {panel ? (
          <aside data-canvas-ui="panel" className="pointer-events-auto absolute left-3 top-20 z-20 w-72 rounded-2xl border border-border/70 bg-background/90 p-3 shadow-xl backdrop-blur-2xl">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{t(panel)}</h2><button type="button" aria-label={t("closePanel")} title={t("closePanel")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setPanel(null)}><X className="size-4" /></button></div>
            {panel === "projects" ? <div className="space-y-2"><input aria-label={t("projectName")} placeholder={t("projectName")} className="h-8 w-full rounded-lg border bg-transparent px-2 text-xs" value={canvas.projectName} onChange={(event) => canvas.setProjectName(event.target.value)} />{canvas.canvases.map((item) => <div key={item.id} className="flex items-center gap-2">{item.id === canvas.activeCanvasID ? <input aria-label={t("canvasName")} className="h-8 min-w-0 flex-1 rounded-lg bg-primary/10 px-2 text-xs text-primary outline-none focus:ring-1 focus:ring-primary/40" value={item.name} onChange={(event) => canvas.renameCanvas(item.id, event.target.value)} /> : <button type="button" className="flex-1 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent" onClick={() => canvas.switchCanvas(item.id)}>{item.name}</button>}<button type="button" aria-label={t("removeCanvas")} title={t("removeCanvas")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive disabled:pointer-events-none disabled:opacity-40" disabled={canvas.canvases.length <= 1} onClick={() => canvas.removeCanvas(item.id)}><Trash2 className="size-3.5" /></button></div>)}<button type="button" className="w-full rounded-lg border py-2 text-xs" onClick={() => canvas.addCanvas()}>{t("newCanvas")}</button>{canvas.bookmarks.map((item) => <div key={item.id} className="flex items-center gap-2"><button type="button" className="flex-1 rounded-lg bg-muted/50 px-2 py-2 text-left text-xs" onClick={() => canvas.goToBookmark(item.id)}>{item.name}</button><button type="button" aria-label={t("removeBookmark")} title={t("removeBookmark")} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive" onClick={() => canvas.removeBookmark(item.id)}><Trash2 className="size-3.5" /></button></div>)}</div> : null}
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
              {!modelsErrorMsg && imageModels.length === 0 ? (
                <Link
                  href="/settings/models"
                  className="pointer-events-auto mt-1 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/90 px-3 text-[11px] font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent"
                >
                  <Settings2 className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
                  {t("noImageModelsAction")}
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 右下角区域预览（资产侧边栏展开时隐藏，避免重叠；桌面端专属） */}
        {canvas.nodes.length > 0 && assetsCollapsed ? (
          <div className="hidden lg:contents">
            <CanvasMinimap
              nodes={canvas.nodes}
              decorations={canvas.decorations}
              viewport={canvas.viewport}
              containerSize={containerSize}
              selectedNodeIDs={canvas.selectedNodeIDs}
              onNavigate={handleMinimapNavigate}
            />
          </div>
        ) : null}

        {/* 资产列表侧边栏（桌面端专属；移动端以对话输入条替代） */}
        <div className="hidden lg:contents">
          <CanvasAssetSidebar
            nodes={canvas.nodes}
            selectedNodeIDs={canvas.selectedNodeIDs}
            collapsed={assetsCollapsed}
            onCollapsedChange={handleAssetsCollapsedChange}
            onSelectNode={(nodeID) => {
              // 输出子节点已合并进生成节点：选中结果时定位到来源生成节点
              const node = canvas.nodes.find((item) => item.id === nodeID);
              const targetID = node?.kind === "output" && node.sourceGenerateID ? node.sourceGenerateID : nodeID;
              canvas.setSelectedNodeIDs([targetID]);
            }}
            onLocate={handleMinimapNavigate}
            onPreviewMedia={(node) => void handlePreviewMedia(node)}
          />
        </div>

        {/* 宽屏固定为节点图模式（无底部输入条）；移动端固定为对话模式。
            移动端点击生成节点时，底部对话框直接内联展示该节点的提示词、素材与参数，
            样式与操作与节点图内的对话框一致，不再额外弹出悬浮面板。 */}
        {compact ? (
          selectedGenerateNode ? (
            <div
              data-canvas-ui="mobile-node-dialog"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-30 max-h-[72vh] overflow-y-auto overscroll-contain px-1.5 pb-1.5"
            >
              <CanvasNodeInspector
                inline
                node={selectedGenerateNode}
                nodes={canvas.nodes}
                edges={canvas.edges}
                models={mediaModels}
                handlers={mobileInspectorHandlers}
              />
            </div>
          ) : (
            <CanvasChatComposer
              imageModels={mediaModels}
              restoredModelKey={canvas.restoredModelKey}
              generatingCount={canvas.generatingCount}
              inherited={inheritedContext}
              onClearInherited={handleClearInheritance}
              onRemoveInheritedAsset={handleRemoveInheritedAsset}
              onAddTask={(input) => void handleChatTask(input)}
            />
          )
        ) : null}

        {/* 移动端定位按钮：小地图在窄屏过于遮挡，改为一键把全部节点缩放到最佳比例并居中 */}
        {canvas.nodes.length > 0 || canvas.decorations.length > 0 ? (
          <button
            type="button"
            data-canvas-ui="locate-all"
            aria-label={t("locateAllNodes")}
            title={t("locateAllNodes")}
            className="pointer-events-auto absolute right-3 bottom-48 z-20 flex size-11 items-center justify-center rounded-2xl border border-border/70 bg-background/90 text-foreground shadow-lg shadow-black/5 backdrop-blur-xl transition-colors hover:bg-accent active:scale-95 lg:hidden"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              handleFit();
            }}
          >
            <Scan className="size-5" strokeWidth={1.8} />
          </button>
        ) : null}
      </CanvasViewport>

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
          setEditingInitialMode("inpaint");
          setEditingNode(node);
        }}
        onDownload={(node) => void handleDownloadNode(node)}
      />
      {/* 资产列表视频/音频预览 */}
      <CanvasMediaLightbox media={previewMedia} onClose={closeMediaPreview} />
      <CanvasImageEditor
        node={editingNode}
        sourceURL={editingSourceURL ?? undefined}
        imageModels={imageModels}
        defaultModel={imageModels[0] ?? null}
        initialMode={editingInitialMode}
        inline
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
