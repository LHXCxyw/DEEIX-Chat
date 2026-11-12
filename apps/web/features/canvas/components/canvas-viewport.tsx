"use client";

import { Box, ChevronDown, ChevronUp, LayoutGrid, LockKeyhole, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  CanvasContextMenu,
  type CanvasContextAction,
  type CanvasContextMenuState,
} from "@/features/canvas/components/canvas-context-menu";
import { type GraphNodeActionHandlers, GraphNodeView } from "@/features/canvas/components/canvas-graph-nodes";
import type { TimelineAttachOption, TimelineSourceInfo } from "@/features/canvas/components/canvas-timeline-node";
import { CanvasNodeInspector } from "@/features/canvas/components/canvas-node-inspector";
import { CanvasAssetToolbar } from "@/features/canvas/components/canvas-asset-toolbar";
import { CanvasFrameCaptureDialog } from "@/features/canvas/components/canvas-frame-capture";
import { CanvasInlineAssetEditor, type InlineEditMode, type InlineEditPayload } from "@/features/canvas/components/canvas-inline-asset-editor";
import type { CanvasReferenceImage } from "@/features/canvas/hooks/use-canvas-store";
import type { CanvasAssetEntry } from "@/features/canvas/model/canvas-assets";
import type { CanvasPromptAssetKind } from "@/features/canvas/model/canvas-prompt";
import type { CanvasNodeReference } from "@/features/canvas/model/canvas-types";
import {
  canConnectGraphNodes,
  type GraphPortID,
  graphEdgeMidpoint,
  graphEdgeNearestPoint,
  graphEdgePath,
  graphNodePorts,
  graphPortCanvasPosition,
  inferGraphConnectionPorts,
} from "@/features/canvas/model/canvas-graph";
import {
  activeElasticDecorationForElement,
  canvasElementIDsInRegion,
  elasticCanvasBounds,
  isCanvasElementCenterInside,
  shouldDetachElasticBoundary,
  viewportForCanvasKey,
} from "@/features/canvas/model/canvas-interactions";
import { zoomViewportAt } from "@/features/canvas/model/canvas-persist";
import { canvasModelKey, type CanvasModelOption } from "@/features/canvas/model/canvas-image-options";
import { canvasAutoConnectOptions, type CanvasAutoConnectOption } from "@/features/canvas/model/canvas-store";
import type {
  CanvasDecoration,
  CanvasMediaKind,
  CanvasMediaType,
  CanvasPointerMode,
  GraphEdge,
  GraphInputPort,
  GraphNode,
  GraphNodeKind,
  GenerateGraphNode,
  ImageGraphNode,
  MediaGraphNode,
  OutputGraphNode,
  TimelineTrackKind,
  CanvasViewport as Viewport,
} from "@/features/canvas/model/canvas-types";
import {
  CANVAS_UI_ATTRIBUTE,
  type GraphNodeUpdate,
  graphNodeSize,
  snapToGrid,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

type ActivePointer = {
  id: number;
  clientX: number;
  clientY: number;
};

type DraggingNodeState = {
  nodeID: string;
  offsetX: number;
  offsetY: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  lastTime: number;
  active: boolean;
  captureTarget: HTMLElement;
  elasticOrigin: CanvasDecoration | null;
  elasticContents: { id: string; x: number; y: number; width: number; height: number }[];
  elasticEnteredDuringDrag: boolean;
  elasticDetached: boolean;
  lastPositions: { nodeID: string; x: number; y: number }[];
  // 多选批量拖动时记录各节点相对拖拽节点的偏移
  siblings: { nodeID: string; offsetX: number; offsetY: number }[];
};

// 端口拖拽连线：fromDirection 区分正向（出端口起拖）与反向（入端口起拖）
type ConnectionDragState = {
  fromNodeID: string;
  fromPort: GraphPortID;
  fromDirection: "in" | "out";
  fromKind: GraphNodeKind;
  // 来源为媒体节点时的素材类型：参考视频 / 参考音频入端口的落点高亮依赖该值
  fromMediaKind?: CanvasMediaKind;
  // 来源为生成节点时的媒体类型：拖到空白处据此创建对应媒体类型的输出节点
  fromMediaType?: CanvasMediaType;
  // 起拖时悬浮连接点的画布坐标：临时连线从这里引出，避免视觉跳动
  origin?: { x: number; y: number };
  pointer: { x: number; y: number };
};

type ElasticDecorationPreview = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tension: number;
};

// 悬浮连接点：指针靠近节点时出现，沿节点四条边就近跟随指针。
// 所有节点只保留这一个点，连线方向与目标端口在落点处自动推断。
type MagnetAnchor = {
  nodeID: string;
  side: "left" | "right" | "top" | "bottom";
  x: number;
  y: number;
};

const NODE_DRAG_THRESHOLD = 4;
// 悬浮连接点的磁吸半径（屏幕像素）：允许指针在节点边缘附近的小范围误差
const MAGNET_RADIUS = 28;
// 悬浮连接点距节点上下边缘的最小留白，避免贴边难以点击
const MAGNET_EDGE_PADDING = 18;
const NODE_CARD_DIAGONAL = Math.hypot(288, 224);
// 橡皮筋最大拉伸量：Frame 边缘 1:1 跟随节点移动，最多跟随约一个卡片对角线后停住。
// 与节点离边缘的距离、Frame 尺寸和屏幕位置无关，弹性手感始终一致
const ELASTIC_MAX_STRETCH = Math.ceil(NODE_CARD_DIAGONAL);
// 刻意甩出才触发脱离的瞬时速度阈值（px/ms），普通快拖约 1.5~2.5，避免误脱离
const ELASTIC_DETACH_VELOCITY = 3;

// 时间线分割产生的新片段 ID：优先用随机 UUID，旧环境退化为时间戳 + 随机数
function createTimelineSegmentID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// 装饰元素（Frame / Section / Note）选中后的 8 向缩放手柄：size-4 命中区中心对齐边框，内嵌可见圆点
const DECORATION_HANDLES: { id: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"; className: string; cursor: string }[] = [
  { id: "nw", className: "-left-2 -top-2", cursor: "cursor-nwse-resize" },
  { id: "n", className: "left-1/2 -top-2 -translate-x-1/2", cursor: "cursor-ns-resize" },
  { id: "ne", className: "-right-2 -top-2", cursor: "cursor-nesw-resize" },
  { id: "e", className: "-right-2 top-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
  { id: "se", className: "-right-2 -bottom-2", cursor: "cursor-nwse-resize" },
  { id: "s", className: "left-1/2 -bottom-2 -translate-x-1/2", cursor: "cursor-ns-resize" },
  { id: "sw", className: "-left-2 -bottom-2", cursor: "cursor-nesw-resize" },
  { id: "w", className: "-left-2 top-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
];
// Section 已移除：所有装饰（组 / 注释）同层渲染，节点位于装饰之上
function decorationLayerRank(_item: CanvasDecoration): number {
  return 0;
}

function withGraphSize(node: GraphNode) {
  return { ...node, ...graphNodeSize(node) };
}

function graphNodeSizeOf(node: Pick<GraphNode, "kind">) {
  return graphNodeSize(node);
}

type MarqueeState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

// 覆盖层（工具栏 / 面板 / 小地图）内的滚轮与指针事件不驱动画布
function isCanvasOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof globalThis.Element)) {
    return false;
  }
  return target.closest(`[${CANVAS_UI_ATTRIBUTE}]`) !== null;
}

// 滚轮落在可滚动的编辑区（长提示词文本框、错误详情等）上时让出缩放，
// 交给原生滚动；内容未溢出的元素仍保持画布缩放体验。
function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof globalThis.Element)) {
    return false;
  }
  const editable = target.closest("textarea, input, pre, [data-canvas-selectable]");
  if (!(editable instanceof HTMLElement)) {
    return false;
  }
  return editable.scrollHeight > editable.clientHeight + 1 || editable.scrollWidth > editable.clientWidth + 1;
}

export function CanvasViewport({
  nodes,
  edges,
  decorations,
  viewport,
  pointerMode,
  selectedNodeIDs,
  selectedDecorationIDs,
  selectedEdgeIDs,
  imageModels,
  showInspector = true,
  interactionLocked,
  containerSize,
  onSelectedNodeIDsChange,
  onSelectedDecorationIDsChange,
  onSelectedEdgeIDsChange,
  onPointerModeChange,
  onUpdateDecoration,
  onMoveDecoration,
  onFocusRegion: _onFocusRegion,
  onViewportChange,
  onBeginNodeMove,
  onMoveNodes,
  onEndNodeMove,
  onUpdateNode,
  onEnsureNodePreview,
  onRemoveNode,
  onRunNode,
  onCancelNode,
  onRequeryNode,
  onRequeryOutputNode,
  onRetryOutputSave,
  onConnectNodes,
  onDropConnection,
  onRemoveEdge,
  onPreviewNode,
  onPreviewResult,
  onDuplicateNodes,
  // 跨项目复制 / 粘贴节点
  onCopyNodes,
  onPasteNodes,
  canPasteNodes = false,
  onPreviewAsset,
  onAttachAsset,
  onDownloadNode,
  onEditReferenceNode,
  onUpscaleAsset,
  onExtractFrame,
  onExtractAudio,
  onExportTimeline,
  onSubmitAssetEdit,
  onUseAsReference,
  uploadReferenceFile,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onRemoveSelected,
  onAddDecoration,
  onArrangeFrame,
  // 外部文件拖入画布：直接导入为素材节点
  onImportFiles,
  children,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  decorations: CanvasDecoration[];
  viewport: Viewport;
  pointerMode: CanvasPointerMode;
  selectedNodeIDs: string[];
  selectedDecorationIDs: string[];
  selectedEdgeIDs: string[];
  imageModels: CanvasModelOption[];
  // 是否渲染悬浮节点对话框：移动端由底部内联对话框承载，关闭此悬浮层
  showInspector?: boolean;
  interactionLocked?: boolean;
  containerSize: { width: number; height: number };
  onSelectedNodeIDsChange: (nodeIDs: string[]) => void;
  onSelectedDecorationIDsChange: (ids: string[]) => void;
  onSelectedEdgeIDsChange: (edgeIDs: string[]) => void;
  onPointerModeChange: (mode: CanvasPointerMode) => void;
  onUpdateDecoration: (id: string, patch: Partial<CanvasDecoration>) => void;
  onMoveDecoration: (id: string, x: number, y: number) => void;
  onFocusRegion: (region: CanvasDecoration) => void;
  onViewportChange: (viewport: Viewport | ((current: Viewport) => Viewport)) => void;
  onBeginNodeMove: () => void;
  onMoveNodes: (positions: { nodeID: string; x: number; y: number }[]) => void;
  onEndNodeMove: () => void;
  onUpdateNode: (nodeID: string, patch: GraphNodeUpdate) => void;
  onEnsureNodePreview: (nodeID: string) => void;
  onRemoveNode: (nodeID: string) => void;
  onRunNode: (nodeID: string) => void;
  onCancelNode: (nodeID: string) => void;
  onRequeryNode: (nodeID: string) => void;
  // 输出节点任务重查：任务绑定随输出节点走，失败的视频输出节点自治回查上游结果
  onRequeryOutputNode: (nodeID: string) => void;
  onRetryOutputSave: (nodeID: string) => void;
  onConnectNodes: (attempt: { fromNodeID: string; fromPort: "out"; toNodeID: string; toPort: GraphInputPort; trackID?: string }) => boolean;
  // 连线拖到空白处：按起拖端口自动创建匹配类型的节点并立即连线
  onDropConnection: (
    drag: {
      fromNodeID: string;
      fromPort: GraphPortID;
      fromDirection: "in" | "out";
      fromKind: GraphNodeKind;
      fromMediaKind?: CanvasMediaKind;
      fromMediaType?: CanvasMediaType;
    },
    point: { x: number; y: number },
    option?: CanvasAutoConnectOption,
  ) => void;
  onRemoveEdge: (edgeID: string) => void;
  onPreviewNode: (node: OutputGraphNode) => void;
  // 合并节点的结果预览：图像走灯箱，视频 / 音频走媒体预览
  onPreviewResult: (node: OutputGraphNode) => void;
  // 右键菜单：复制选中节点副本
  onDuplicateNodes: (nodeIDs: string[]) => void;
  // 跨项目复制 / 粘贴节点
  onCopyNodes?: (nodeIDs: string[]) => void;
  onPasteNodes?: (point?: { x: number; y: number }) => void;
  canPasteNodes?: boolean;
  // 对话框内 @ 素材的预览
  onPreviewAsset: (asset: CanvasAssetEntry) => void;
  // 对话框添加素材：同步创建/复用素材节点并连线
  onAttachAsset: (nodeID: string, reference: CanvasNodeReference, kind: CanvasPromptAssetKind, previewURL?: string) => void;
  onDownloadNode: (node: OutputGraphNode) => void;
  onEditNode: (node: OutputGraphNode) => void;
  onEditReferenceNode: (node: ImageGraphNode | OutputGraphNode, mode?: "inpaint" | "crop" | "outpaint") => void;
  // 素材悬浮工具栏：超清（2K/4K）、视频截帧、分离音频
  onUpscaleAsset: (node: ImageGraphNode | OutputGraphNode, tier: "2K" | "4K", model: CanvasModelOption) => void;
  onExtractFrame: (node: MediaGraphNode | OutputGraphNode, frame?: "first" | "last" | number) => void;
  onExtractAudio: (node: MediaGraphNode | OutputGraphNode) => void;
  // 时间线节点：导出拼接结果到画布（后端 ffmpeg 处理）
  onExportTimeline: (nodeID: string) => void;
  // 画布内联素材编辑提交：生成新节点并自动连线
  onSubmitAssetEdit: (nodeID: string, payload: InlineEditPayload) => Promise<boolean>;
  onUseAsReference: (node: OutputGraphNode) => void;
  uploadReferenceFile: (file: File) => Promise<CanvasReferenceImage | null>;
  // 右键菜单动作
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onRemoveSelected: () => void;
  onAddDecoration: (kind: "frame" | "note") => void;
  // 组表头：按依赖关系自动排版组内节点
  onArrangeFrame: (frameID: string) => void;
  onImportFiles?: (files: File[], point: { x: number; y: number }) => void;
  children?: React.ReactNode;
}) {
  const t = useTranslations("canvas");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();
  const pointersRef = React.useRef(new Map<number, ActivePointer>());
  const panStartRef = React.useRef<{ x: number; y: number; viewportX: number; viewportY: number } | null>(null);
  const pinchStartRef = React.useRef<{ distance: number; scale: number } | null>(null);
  const draggingNodeRef = React.useRef<DraggingNodeState | null>(null);
  const connectionDragRef = React.useRef<ConnectionDragState | null>(null);
  const [connectionDrag, setConnectionDrag] = React.useState<ConnectionDragState | null>(null);
  // 悬浮连接点：状态与最近一次待提交值分开，pointermove 时用 rAF 合并刷新
  const [magnetAnchor, setMagnetAnchor] = React.useState<MagnetAnchor | null>(null);
  const magnetAnchorRef = React.useRef<MagnetAnchor | null>(null);
  const magnetFrameRef = React.useRef<number | null>(null);
  // 连线拖拽中吸附的目标节点：靠近节点即高亮并跟随指针，无需精确点到点
  const [connectionTarget, setConnectionTarget] = React.useState<MagnetAnchor | null>(null);
  const connectionTargetRef = React.useRef<MagnetAnchor | null>(null);
  // 连线删除按钮：跟随指针显示在线条最近位置，避免固定中点被节点遮挡
  const [edgeHover, setEdgeHover] = React.useState<{ edgeID: string; x: number; y: number } | null>(null);
  const edgeHoverRef = React.useRef<{ edgeID: string; x: number; y: number } | null>(null);
  const viewportRef = React.useRef(viewport);
  const nodesRef = React.useRef(nodes);
  const decorationsRef = React.useRef(decorations);
  const selectedRef = React.useRef(selectedNodeIDs);
  const interactionLockedRef = React.useRef(Boolean(interactionLocked));
  const [marquee, setMarquee] = React.useState<MarqueeState | null>(null);
  const [elasticPreview, setElasticPreview] = React.useState<ElasticDecorationPreview | null>(null);
  const elasticPreviewRef = React.useRef<ElasticDecorationPreview | null>(null);
  const marqueeRef = React.useRef<MarqueeState | null>(null);
  const marqueeAdditiveRef = React.useRef(false);
  const marqueeBaseSelectionRef = React.useRef<string[]>([]);
  const [spacePressed, setSpacePressed] = React.useState(false);
  const spacePressedRef = React.useRef(false);
  // 按住 Ctrl 临时切换到另一种指针模式
  const [ctrlPressed, setCtrlPressed] = React.useState(false);
  const ctrlPressedRef = React.useRef(false);
  // 拖动节点时的对齐参考线（画布坐标）
  const [alignGuides, setAlignGuides] = React.useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const moveFrameRef = React.useRef<number | null>(null);
  const pendingMoveRef = React.useRef<{ nodeID: string; x: number; y: number }[] | null>(null);
  const [contextMenu, setContextMenu] = React.useState<CanvasContextMenuState | null>(null);
  // 关闭节点检查器：仅隐藏面板，不取消选中
  const [inspectorDismissedID, setInspectorDismissedID] = React.useState<string | null>(null);
  // 素材悬浮工具栏：被操作的素材节点与所选编辑模型
  const [assetToolbarNodeID, setAssetToolbarNodeID] = React.useState<string | null>(null);
  const [assetToolbarModelKey, setAssetToolbarModelKey] = React.useState<string | null>(null);
  // 自定义截帧面板：记录被截帧的视频节点
  const [frameCaptureNodeID, setFrameCaptureNodeID] = React.useState<string | null>(null);
  // 画布内联素材编辑：在节点图区域上直接裁剪/蒙版操作
  const [inlineEdit, setInlineEdit] = React.useState<{ nodeID: string; mode: InlineEditMode; modelKey: string } | null>(null);
  const [inlineBusy, setInlineBusy] = React.useState(false);
  // 拖到空白处的节点类型选择菜单：先选类型再创建并连线
  const [connectionMenu, setConnectionMenu] = React.useState<{
    screen: { x: number; y: number };
    point: { x: number; y: number };
    drag: ConnectionDragState;
    options: CanvasAutoConnectOption[];
  } | null>(null);

  React.useEffect(() => {
    setInspectorDismissedID(null);
  }, [selectedNodeIDs]);

  // 折叠 Frame 的成员节点与内嵌装饰收纳隐藏，展开后按原位还原
  const collapsedFrameIDs = React.useMemo(
    () => new Set(decorations.filter((item) => item.kind === "frame" && item.collapsed).map((item) => item.id)),
    [decorations],
  );
  // 输出子节点已合并进生成节点卡片：不再单独渲染，也不参与框选与装饰统计
  const absorbedOutputIDs = React.useMemo(() => {
    const ids = new Set<string>();
    for (const node of nodes) {
      if (node.kind === "output" && node.sourceGenerateID && nodes.some((item) => item.id === node.sourceGenerateID)) {
        ids.add(node.id);
      }
    }
    return ids;
  }, [nodes]);
  const resultByGenerate = React.useMemo(() => {
    const map = new Map<string, OutputGraphNode>();
    for (const node of nodes) {
      if (node.kind !== "output" || !node.sourceGenerateID || !absorbedOutputIDs.has(node.id)) {
        continue;
      }
      const existing = map.get(node.sourceGenerateID);
      if (!existing || existing.createdAt <= node.createdAt) {
        map.set(node.sourceGenerateID, node);
      }
    }
    return map;
  }, [absorbedOutputIDs, nodes]);
  // 时间线片段来源：按片段记录源节点名称与可播放地址，供时长读取与分割使用
  const timelineSourcesByNode = React.useMemo(() => {
    const map = new Map<string, TimelineSourceInfo[]>();
    const nodeByID = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (node.kind !== "timeline") {
        continue;
      }
      const sources: TimelineSourceInfo[] = [];
      for (const segment of node.segments) {
        const source = nodeByID.get(segment.sourceNodeID);
        if (!source) {
          continue;
        }
        let name = source.id;
        let previewURL: string | undefined;
        if (source.kind === "media" || source.kind === "image") {
          name = source.reference?.fileName ?? source.id;
          previewURL = source.previewURL;
        } else if (source.kind === "output") {
          name = source.fileName ?? source.id;
          previewURL = source.previewURL ?? source.objectURL;
        } else if (source.kind === "generate") {
          const result = resultByGenerate.get(source.id);
          name = result?.fileName ?? source.model ?? source.id;
          previewURL = result?.previewURL ?? result?.objectURL ?? source.previewURL;
        }
        sources.push({
          segmentID: segment.id,
          sourceNodeID: source.id,
          // 轨道类型按来源媒体判断：自定义轨道 id（audio-2 等）不参与类型判定
          track: source.kind === "media" && source.mediaKind === "audio" ? "audio" : "video",
          name,
          previewURL,
        });
      }
      map.set(node.id, sources);
    }
    return map;
  }, [nodes, resultByGenerate]);
  // 时间线 + 按钮的可选来源：画布上尚未接入的参考视频与视频生成节点
  const timelineAttachOptionsByNode = React.useMemo(() => {
    const map = new Map<string, TimelineAttachOption[]>();
    for (const node of nodes) {
      if (node.kind !== "timeline") {
        continue;
      }
      const connected = new Set(node.segments.map((segment) => segment.sourceNodeID));
      const options: TimelineAttachOption[] = [];
      for (const item of nodes) {
        if (item.id === node.id || connected.has(item.id) || absorbedOutputIDs.has(item.id)) {
          continue;
        }
        if (item.kind === "media" && item.mediaKind === "video") {
          options.push({ nodeID: item.id, name: item.reference?.fileName ?? item.id, previewURL: item.previewURL, track: "video" });
        } else if (item.kind === "media" && item.mediaKind === "audio") {
          options.push({ nodeID: item.id, name: item.reference?.fileName ?? item.id, previewURL: item.previewURL, track: "audio" });
        } else if (item.kind === "generate" && item.mediaType === "video") {
          const result = resultByGenerate.get(item.id);
          options.push({ nodeID: item.id, name: result?.fileName ?? item.model ?? item.id, previewURL: result?.previewURL, track: "video" });
        }
      }
      map.set(node.id, options);
    }
    return map;
  }, [absorbedOutputIDs, nodes, resultByGenerate]);
  const presentableNodes = React.useMemo(() => {
    const visible = nodes.filter((node) => !absorbedOutputIDs.has(node.id));
    return collapsedFrameIDs.size === 0
      ? visible
      : visible.filter((node) => !node.frameID || !collapsedFrameIDs.has(node.frameID));
  }, [nodes, absorbedOutputIDs, collapsedFrameIDs]);
  const presentableDecorations = React.useMemo(
    () => collapsedFrameIDs.size === 0
      ? decorations
      : decorations.filter((item) => !item.frameID || !collapsedFrameIDs.has(item.frameID)),
    [decorations, collapsedFrameIDs],
  );
  // 渲染用连线：隐藏生成→输出的内部连线；结果作为参考来源时把起点重定向到来源生成节点
  const displayEdges = React.useMemo(() => {
    const parentByOutput = new Map<string, string>();
    for (const node of nodes) {
      if (node.kind === "output" && node.sourceGenerateID) {
        parentByOutput.set(node.id, node.sourceGenerateID);
      }
    }
    const seen = new Set<string>();
    const list: GraphEdge[] = [];
    for (const edge of edges) {
      if (absorbedOutputIDs.has(edge.toNodeID)) {
        continue;
      }
      const fromNodeID = parentByOutput.get(edge.fromNodeID) ?? edge.fromNodeID;
      const key = `${fromNodeID}\u0000${edge.toNodeID}\u0000${edge.toPort}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      list.push(fromNodeID === edge.fromNodeID ? edge : { ...edge, fromNodeID });
    }
    return list;
  }, [absorbedOutputIDs, edges, nodes]);

  React.useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  React.useEffect(() => {
    nodesRef.current = presentableNodes;
  }, [presentableNodes]);

  React.useEffect(() => {
    decorationsRef.current = presentableDecorations;
  }, [presentableDecorations]);

  React.useEffect(() => {
    selectedRef.current = selectedNodeIDs;
  }, [selectedNodeIDs]);

  React.useEffect(() => {
    interactionLockedRef.current = Boolean(interactionLocked);
  }, [interactionLocked]);

  React.useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      // 跨项目复制 / 粘贴节点
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "c" && selectedRef.current.length > 0) {
          event.preventDefault();
          onCopyNodes?.(selectedRef.current);
          return;
        }
        if (key === "v") {
          event.preventDefault();
          onPasteNodes?.();
          return;
        }
      }
      // 连线拖拽中 ESC 取消
      if (event.key === "Escape" && connectionDragRef.current) {
        connectionDragRef.current = null;
        setConnectionDrag(null);
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") {
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "h") {
        return;
      }
      if (event.code !== "Space") return;
      event.preventDefault();
      if (!event.repeat) {
        spacePressedRef.current = true;
        setSpacePressed(true);
      }
    };
    const releaseSpace = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    const resetSpace = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", releaseSpace);
    window.addEventListener("blur", resetSpace);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", releaseSpace);
      window.removeEventListener("blur", resetSpace);
    };
  }, [onCopyNodes, onPasteNodes, onPointerModeChange, t]);

  React.useEffect(() => () => {
    if (moveFrameRef.current !== null) {
      cancelAnimationFrame(moveFrameRef.current);
    }
  }, []);

  const selectedSet = React.useMemo(() => new Set(selectedNodeIDs), [selectedNodeIDs]);

  const toCanvasPoint = React.useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const current = viewportRef.current;
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return {
      x: (clientX - rect.left - current.x) / current.scale,
      y: (clientY - rect.top - current.y) / current.scale,
    };
  }, []);

  // 锚定光标缩放
  const zoomAt = React.useCallback(
    (clientX: number, clientY: number, nextScale: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const current = viewportRef.current;
      const pivot = { x: clientX - rect.left, y: clientY - rect.top };
      onViewportChange(zoomViewportAt(current, pivot, nextScale));
    },
    [onViewportChange],
  );

  const refreshElasticPreview = React.useCallback((dragging: DraggingNodeState) => {
    if (!dragging.elasticOrigin || dragging.elasticDetached || dragging.lastPositions.length === 0) return;
    const positions = new Map(dragging.lastPositions.map((item) => [item.nodeID, item]));
    const contents = dragging.elasticContents.map((item) => ({ ...item, ...positions.get(item.id) }));
    const bounds = elasticCanvasBounds(dragging.elasticOrigin, contents, ELASTIC_MAX_STRETCH, 24, 72);
    const preview = { id: dragging.elasticOrigin.id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, tension: 0 };
    elasticPreviewRef.current = preview;
    setElasticPreview(preview);
  }, []);

  const clearElasticPreview = React.useCallback((commit: boolean) => {
    const preview = elasticPreviewRef.current;
    if (commit && preview) {
      onUpdateDecoration(preview.id, {
        x: snapToGrid(preview.x),
        y: snapToGrid(preview.y),
        width: snapToGrid(preview.width),
        height: snapToGrid(preview.height),
      });
    }
    elasticPreviewRef.current = null;
    setElasticPreview(null);
  }, [onUpdateDecoration]);

  // 指针在容器外释放时兜底清理，避免平移/拖拽/连线状态残留
  React.useEffect(() => {
    const handleWindowPointerUp = () => {
      pointersRef.current.clear();
      pinchStartRef.current = null;
      panStartRef.current = null;
      if (draggingNodeRef.current?.active) {
        if (moveFrameRef.current !== null) {
          cancelAnimationFrame(moveFrameRef.current);
          moveFrameRef.current = null;
        }
        const positions = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (positions) {
          onMoveNodes(positions);
        }
        refreshElasticPreview(draggingNodeRef.current);
        clearElasticPreview(true);
        onEndNodeMove();
      }
      draggingNodeRef.current = null;
      setAlignGuides({ x: null, y: null });
      document.body.style.userSelect = "";
      if (connectionDragRef.current) {
        connectionDragRef.current = null;
        setConnectionDrag(null);
      }
      if (marqueeRef.current) {
        marqueeRef.current = null;
        setMarquee(null);
      }
    };
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
    return () => {
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerUp);
    };
  }, [clearElasticPreview, onEndNodeMove, onMoveNodes, refreshElasticPreview]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Control") {
        return;
      }
      ctrlPressedRef.current = true;
      setCtrlPressed(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control") {
        return;
      }
      ctrlPressedRef.current = false;
      setCtrlPressed(false);
    };
    const handleBlur = () => {
      ctrlPressedRef.current = false;
      setCtrlPressed(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  // 当前生效的指针模式：按住 Ctrl 临时切换到另一种
  const effectivePointerMode = ctrlPressed
    ? (pointerMode === "pan" ? "select" : "pan")
    : pointerMode;

  // 滚轮固定为缩放；覆盖层与锁定状态下不处理，避免下拉选择器影响画布
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (interactionLockedRef.current || isCanvasOverlayTarget(event.target) || isEditableScrollTarget(event.target)) {
        return;
      }
      event.preventDefault();
      const current = viewportRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      zoomAt(event.clientX, event.clientY, current.scale * factor);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [zoomAt]);

  // 悬浮连接点刷新：pointermove 高频触发，使用 rAF 合并为每帧一次状态更新
  const updateMagnetAnchor = React.useCallback((next: MagnetAnchor | null) => {
    const previous = magnetAnchorRef.current;
    const unchanged = previous && next
      && previous.nodeID === next.nodeID
      && previous.side === next.side
      && Math.abs(previous.x - next.x) < 0.5
      && Math.abs(previous.y - next.y) < 0.5;
    if (unchanged) {
      return;
    }
    magnetAnchorRef.current = next;
    if (magnetFrameRef.current !== null) {
      return;
    }
    magnetFrameRef.current = window.requestAnimationFrame(() => {
      magnetFrameRef.current = null;
      setMagnetAnchor(magnetAnchorRef.current);
    });
  }, []);

  React.useEffect(() => () => {
    if (magnetFrameRef.current !== null) {
      window.cancelAnimationFrame(magnetFrameRef.current);
      magnetFrameRef.current = null;
    }
  }, []);

  // 连线删除按钮状态：仅在命中变化或位置明显移动时更新，避免每帧重渲染
  const updateEdgeHover = React.useCallback((next: { edgeID: string; x: number; y: number } | null) => {
    const previous = edgeHoverRef.current;
    if (!previous && !next) {
      return;
    }
    if (
      previous && next
      && previous.edgeID === next.edgeID
      && Math.abs(previous.x - next.x) < 1
      && Math.abs(previous.y - next.y) < 1
    ) {
      return;
    }
    edgeHoverRef.current = next;
    setEdgeHover(next);
  }, []);

  // 命中测试：指针落在节点内或边缘 MAGNET_RADIUS 范围内时，返回该节点的单连接点。
  // 取节点矩形四条边中离指针最近的一条，连接点沿该边跟随指针，可上下左右移动。
  const findMagnetAnchor = React.useCallback((point: { x: number; y: number }): MagnetAnchor | null => {
    const scale = viewportRef.current.scale || 1;
    const tolerance = MAGNET_RADIUS / scale;
    let best: { anchor: MagnetAnchor; distance: number; centerDistance: number } | null = null;
    for (const node of nodesRef.current) {
      // 输出节点已吸收进生成节点卡片，锁定节点不参与连线
      if (node.kind === "output" || node.locked) {
        continue;
      }
      const size = graphNodeSizeOf(node);
      const deltaX = Math.max(node.x - point.x, 0, point.x - (node.x + size.width));
      const deltaY = Math.max(node.y - point.y, 0, point.y - (node.y + size.height));
      const distance = Math.hypot(deltaX, deltaY);
      if (distance > tolerance) {
        continue;
      }
      const left = node.x;
      const top = node.y;
      const right = node.x + size.width;
      const clampY = Math.min(Math.max(point.y, top + MAGNET_EDGE_PADDING), node.y + size.height - MAGNET_EDGE_PADDING);
      // 连接点只出现在节点左右两侧：左侧输入、右侧输出，输入/输出不混用
      const ports = graphNodePorts(node.kind, node.kind === "generate" ? node.mediaType : undefined);
      const candidates: { side: MagnetAnchor["side"]; x: number; y: number; distance: number }[] = [];
      if (ports.some((port) => port.direction === "in")) {
        candidates.push({ side: "left", x: left - 6, y: clampY, distance: Math.abs(point.x - left) });
      }
      if (ports.some((port) => port.direction === "out")) {
        candidates.push({ side: "right", x: right + 6, y: clampY, distance: Math.abs(point.x - right) });
      }
      if (candidates.length === 0) {
        continue;
      }
      const nearest = candidates.reduce((current, item) => (item.distance < current.distance ? item : current), candidates[0]);
      const anchor: MagnetAnchor = {
        nodeID: node.id,
        side: nearest.side,
        x: nearest.x,
        y: nearest.y,
      };
      const centerDistance = Math.hypot(
        point.x - (node.x + size.width / 2),
        point.y - (node.y + size.height / 2),
      );
      if (!best || distance < best.distance || (distance === best.distance && centerDistance < best.centerDistance)) {
        best = { anchor, distance, centerDistance };
      }
    }
    return best?.anchor ?? null;
  }, []);

  // 单连接点连线的落点解析：先按「起点 -> 落点」推断，再反向尝试，
  // 兼容从生成节点拖到文本节点等反向操作；返回第一条通过校验的连线。
  const resolveConnectionAttempt = React.useCallback((fromNodeID: string, toNodeID: string): {
    fromNodeID: string;
    fromPort: "out";
    toNodeID: string;
    toPort: GraphInputPort;
  } | null => {
    if (fromNodeID === toNodeID) {
      return null;
    }
    const source = nodesRef.current.find((node) => node.id === fromNodeID);
    const target = nodesRef.current.find((node) => node.id === toNodeID);
    if (!source || !target) {
      return null;
    }
    const candidates = [
      ...inferGraphConnectionPorts(source, target).map((toPort) => ({
        fromNodeID: source.id,
        fromPort: "out" as const,
        toNodeID: target.id,
        toPort,
      })),
      ...inferGraphConnectionPorts(target, source).map((toPort) => ({
        fromNodeID: target.id,
        fromPort: "out" as const,
        toNodeID: source.id,
        toPort,
      })),
    ];
    const matched = candidates.find((attempt) => canConnectGraphNodes(nodesRef.current, edges, attempt).ok);
    if (!matched) {
      return null;
    }
    return matched;
  }, [edges]);

  // 从悬浮连接点起拖连线；方向与目标端口在落点自动推断
  const beginConnectionDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, nodeID: string) => {
      const node = nodesRef.current.find((item) => item.id === nodeID);
      if (!node) {
        return;
      }
      // 起拖前记录悬浮点位置，临时连线从用户按下的位置引出
      const anchor = magnetAnchorRef.current?.nodeID === nodeID ? magnetAnchorRef.current : null;
      updateMagnetAnchor(null);
      setConnectionTarget(null);
      connectionTargetRef.current = null;
      setEdgeHover(null);
      const pointer = toCanvasPoint(event.clientX, event.clientY);
      const drag: ConnectionDragState = {
        fromNodeID: nodeID,
        fromPort: "out",
        fromDirection: "out",
        fromKind: node.kind,
        fromMediaKind: node.kind === "media" ? node.mediaKind : undefined,
        // 生成节点与输出节点都携带媒体类型：前者决定输出节点的类型，后者决定回灌的参考端口
        fromMediaType: node.kind === "generate" || node.kind === "output" ? node.mediaType : undefined,
        origin: anchor ? { x: anchor.x, y: anchor.y } : undefined,
        pointer,
      };
      connectionDragRef.current = drag;
      setConnectionDrag(drag);
      // 捕获指针：拖出画布容器后仍能收到移动与释放事件
      containerRef.current?.setPointerCapture?.(event.pointerId);
    },
    [toCanvasPoint, updateMagnetAnchor],
  );

  // 释放连线：优先连到拖拽中吸附的目标节点，其次按元素命中，最后在空白处补节点
  const finishConnectionDrag = React.useCallback(
    (clientX: number, clientY: number) => {
      const drag = connectionDragRef.current;
      connectionDragRef.current = null;
      setConnectionDrag(null);
      const magnetTarget = connectionTargetRef.current;
      connectionTargetRef.current = null;
      setConnectionTarget(null);
      if (!drag) {
        return;
      }
      const element = document.elementFromPoint(clientX, clientY);
      // 落在工具栏 / 对话框等覆盖层上时取消，避免误建节点
      if (element && element.closest(`[${CANVAS_UI_ATTRIBUTE}]`)) {
        return;
      }
      // 吸附目标：指针靠近节点即视为落点，无需精确点击连接点
      if (magnetTarget) {
        const attempt = resolveConnectionAttempt(drag.fromNodeID, magnetTarget.nodeID);
        if (attempt) {
          onConnectNodes(attempt);
          return;
        }
      }
      const nodeElement = element?.closest("[data-canvas-node-id]") as HTMLElement | null;
      const anchorElement = element?.closest("[data-canvas-connection-anchor]") as HTMLElement | null;
      const targetNodeID = nodeElement?.dataset.canvasNodeId
        ?? anchorElement?.dataset.canvasConnectionNodeId
        ?? "";
      if (!targetNodeID) {
        // 松开在空白处：先让用户选择要创建的节点类型，再创建并连线
        const point = toCanvasPoint(clientX, clientY);
        const options = canvasAutoConnectOptions(drag);
        if (options.length === 0) {
          return;
        }
        if (options.length === 1) {
          onDropConnection(drag, point, options[0]);
          return;
        }
        const rect = containerRef.current?.getBoundingClientRect();
        setConnectionMenu({
          screen: { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) },
          point,
          drag,
          options,
        });
        return;
      }
      const attempt = resolveConnectionAttempt(drag.fromNodeID, targetNodeID);
      if (attempt) {
        onConnectNodes(attempt);
      }
    },
    [onConnectNodes, onDropConnection, resolveConnectionAttempt, toCanvasPoint],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (interactionLocked || isCanvasOverlayTarget(event.target)) {
        return;
      }
      // 点击画布其它位置关闭节点类型选择菜单
      setConnectionMenu(null);
      const isMiddleButton = event.button === 1;
      const temporaryPan = spacePressedRef.current && event.button === 0;
      if (event.button !== 0 && !isMiddleButton && event.pointerType === "mouse") {
        return;
      }
      pointersRef.current.set(event.pointerId, {
        id: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      if (pointersRef.current.size === 2) {
        panStartRef.current = null;
        const [first, second] = [...pointersRef.current.values()];
        pinchStartRef.current = {
          distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
          scale: viewportRef.current.scale,
        };
        return;
      }

      const target = event.target as HTMLElement;
      // 悬浮连接点起拖连线，不触发节点拖拽
      const anchorElement = target.closest("[data-canvas-connection-anchor]") as HTMLElement | null;
      if (anchorElement && !isMiddleButton && !temporaryPan) {
        event.preventDefault();
        const anchorNodeID = anchorElement.dataset.canvasConnectionNodeId ?? "";
        if (anchorNodeID) {
          beginConnectionDrag(event, anchorNodeID);
          return;
        }
      }
      // 非连线交互按下时收起悬浮连接点：拖节点、框选与平移都不应被点遮挡
      updateMagnetAnchor(null);
      // 节点内可选中/可交互区域不触发拖拽，保证文本选择与控件交互
      if (target.closest("[data-canvas-selectable]")) {
        return;
      }
      const nodeElement = target.closest("[data-canvas-node-id]") as HTMLElement | null;
      const nodeID = nodeElement?.dataset.canvasNodeId ?? "";
      const node = presentableNodes.find((item) => item.id === nodeID);
      if (node && nodeElement && !isMiddleButton && !temporaryPan) {
        event.currentTarget.focus({ preventScroll: true });
        const additiveSelection = event.metaKey || event.ctrlKey || event.shiftKey;
        if (additiveSelection) {
          const nextSelection = selectedRef.current.includes(nodeID)
            ? selectedRef.current.filter((id) => id !== nodeID)
            : [...selectedRef.current, nodeID];
          onSelectedNodeIDsChange(nextSelection);
          return;
        }
        if (node.locked) {
          onSelectedNodeIDsChange([nodeID]);
          return;
        }
        const point = toCanvasPoint(event.clientX, event.clientY);
        const nodeSize = graphNodeSizeOf(node);
        const explicitSelection = selectedRef.current.includes(nodeID) ? selectedRef.current : [nodeID];
        const groupSelection = node.groupID ? [...new Set([...explicitSelection, ...presentableNodes.filter((item) => item.groupID === node.groupID).map((item) => item.id)])] : explicitSelection;
        const elasticOrigin = presentableDecorations
          .filter((item) => item.kind === "frame" && !item.locked)
          .filter((item) => isCanvasElementCenterInside(item, { ...node, width: nodeSize.width, height: nodeSize.height }))
          .sort((a, b) => a.width * a.height - b.width * b.height || a.id.localeCompare(b.id))[0] ?? null;
        draggingNodeRef.current = {
          nodeID,
          offsetX: point.x - node.x,
          offsetY: point.y - node.y,
          startClientX: event.clientX,
          startClientY: event.clientY,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          lastTime: event.timeStamp,
          active: false,
          captureTarget: nodeElement,
          elasticOrigin,
          elasticContents: elasticOrigin
            ? [
              ...presentableNodes.map(withGraphSize),
              ...presentableDecorations.filter((item) => item.id !== elasticOrigin.id),
            ].filter((item) => isCanvasElementCenterInside(elasticOrigin, item))
            : [],
          elasticEnteredDuringDrag: false,
          elasticDetached: false,
          lastPositions: [],
          siblings: groupSelection
            .filter((id) => id !== nodeID)
            .flatMap((id) => {
              const sibling = presentableNodes.find((item) => item.id === id);
              return sibling
                ? [{ nodeID: id, offsetX: sibling.x - node.x, offsetY: sibling.y - node.y }]
                : [];
            }),
        };
        if (!selectedRef.current.includes(nodeID)) {
          onSelectedNodeIDsChange([nodeID]);
        }
        // 轻点时不抢占 pointer capture，保证节点内按钮能收到 click；
        // 指针移动超过阈值后再进入正式拖拽。
        return;
      }

      // 框选模式下拖拽背景绘制选框；中键始终平移
      const effectiveMode = ctrlPressedRef.current ? (pointerMode === "pan" ? "select" : "pan") : pointerMode;
      if (effectiveMode === "select" && !isMiddleButton && !temporaryPan) {
        const point = toCanvasPoint(event.clientX, event.clientY);
        const next = { startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
        const additiveSelection = event.metaKey || event.ctrlKey || event.shiftKey;
        marqueeAdditiveRef.current = additiveSelection;
        marqueeBaseSelectionRef.current = additiveSelection ? selectedRef.current : [];
        marqueeRef.current = next;
        setMarquee(next);
        if (!additiveSelection) {
          onSelectedNodeIDsChange([]);
          onSelectedDecorationIDsChange([]);
          onSelectedEdgeIDsChange([]);
        }
        // 捕获指针，拖到容器外仍能持续更新并正常提交选区
        containerRef.current?.setPointerCapture?.(event.pointerId);
        return;
      }

      panStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        viewportX: viewportRef.current.x,
        viewportY: viewportRef.current.y,
      };
      if (!temporaryPan) {
        onSelectedNodeIDsChange([]);
        onSelectedDecorationIDsChange([]);
        onSelectedEdgeIDsChange([]);
      }
      containerRef.current?.setPointerCapture?.(event.pointerId);
    },
    [beginConnectionDrag, interactionLocked, onSelectedDecorationIDsChange, onSelectedEdgeIDsChange, onSelectedNodeIDsChange, pointerMode, presentableDecorations, presentableNodes, toCanvasPoint, updateMagnetAnchor],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 空闲悬停：命中节点附近时显示跟随指针的单连接点；靠近线条时显示删除按钮
      if (
        event.buttons === 0
        && !connectionDragRef.current
        && !draggingNodeRef.current
        && !panStartRef.current
        && !spacePressedRef.current
      ) {
        const overlay = isCanvasOverlayTarget(event.target);
        const point = toCanvasPoint(event.clientX, event.clientY);
        updateMagnetAnchor(overlay ? null : findMagnetAnchor(point));
        if (overlay) {
          updateEdgeHover(null);
        } else {
          // 删除按钮跟随指针在线条最近点显示，避免固定中点被节点遮挡
          const threshold = 12 / (viewportRef.current.scale || 1);
          let nearest: { edgeID: string; x: number; y: number; distance: number } | null = null;
          for (const line of connectionLinesRef.current) {
            const hit = graphEdgeNearestPoint(line.fromPoint, line.toPoint, point);
            if (hit.distance <= threshold && (!nearest || hit.distance < nearest.distance)) {
              nearest = { edgeID: line.id, x: hit.x, y: hit.y, distance: hit.distance };
            }
          }
          updateEdgeHover(nearest ? { edgeID: nearest.edgeID, x: nearest.x, y: nearest.y } : null);
        }
      }
      if (!pointersRef.current.has(event.pointerId)) {
        return;
      }
      pointersRef.current.set(event.pointerId, {
        id: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      // 双指捏合缩放
      if (pointersRef.current.size === 2 && pinchStartRef.current) {
        const [first, second] = [...pointersRef.current.values()];
        const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
        if (distance > 0 && pinchStartRef.current.distance > 0) {
          const midX = (first.clientX + second.clientX) / 2;
          const midY = (first.clientY + second.clientY) / 2;
          const ratio = distance / pinchStartRef.current.distance;
          zoomAt(midX, midY, pinchStartRef.current.scale * ratio);
        }
        return;
      }

      // 端口连线拖拽：更新临时连线终点，并吸附最近的目标节点
      const connectionDragState = connectionDragRef.current;
      if (connectionDragState) {
        const pointer = toCanvasPoint(event.clientX, event.clientY);
        const next = { ...connectionDragState, pointer };
        connectionDragRef.current = next;
        setConnectionDrag(next);
        const anchor = findMagnetAnchor(pointer);
        const target = anchor && anchor.nodeID !== connectionDragState.fromNodeID ? anchor : null;
        if (connectionTargetRef.current?.nodeID !== target?.nodeID) {
          connectionTargetRef.current = target;
          setConnectionTarget(target);
        }
        return;
      }

      const dragging = draggingNodeRef.current;
      if (dragging) {
        if (!dragging.active) {
          const distance = Math.hypot(
            event.clientX - dragging.startClientX,
            event.clientY - dragging.startClientY,
          );
          if (distance < NODE_DRAG_THRESHOLD) {
            return;
          }
          dragging.active = true;
          onBeginNodeMove();
          document.body.style.userSelect = "none";
          dragging.captureTarget.setPointerCapture?.(event.pointerId);
        }
        const point = toCanvasPoint(event.clientX, event.clientY);
        const baseX = snapToGrid(point.x - dragging.offsetX);
        const baseY = snapToGrid(point.y - dragging.offsetY);
        const elapsed = Math.max(1, event.timeStamp - dragging.lastTime);
        const velocity = Math.hypot(event.clientX - dragging.lastClientX, event.clientY - dragging.lastClientY) / elapsed;
        dragging.lastClientX = event.clientX;
        dragging.lastClientY = event.clientY;
        dragging.lastTime = event.timeStamp;
        const draggedSize = graphNodeSizeOf(nodesRef.current.find((item) => item.id === dragging.nodeID) ?? { kind: "prompt" } as GraphNode);

        // 与其它节点的边缘 / 中线对齐吸附，并记录对齐参考线
        const snapThreshold = 6 / (viewportRef.current.scale || 1);
        let bestX: { diff: number; guide: number } | null = null;
        let bestY: { diff: number; guide: number } | null = null;
        const draggedXs = [baseX, baseX + draggedSize.width / 2, baseX + draggedSize.width];
        const draggedYs = [baseY, baseY + draggedSize.height / 2, baseY + draggedSize.height];
        const siblingIDs = new Set(dragging.siblings.map((sibling) => sibling.nodeID));
        for (const other of nodesRef.current) {
          if (other.id === dragging.nodeID || siblingIDs.has(other.id) || other.kind === "output") {
            continue;
          }
          const otherSize = graphNodeSizeOf(other);
          for (const guide of [other.x, other.x + otherSize.width / 2, other.x + otherSize.width]) {
            for (const edge of draggedXs) {
              const diff = guide - edge;
              if (Math.abs(diff) <= snapThreshold && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
                bestX = { diff, guide };
              }
            }
          }
          for (const guide of [other.y, other.y + otherSize.height / 2, other.y + otherSize.height]) {
            for (const edge of draggedYs) {
              const diff = guide - edge;
              if (Math.abs(diff) <= snapThreshold && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
                bestY = { diff, guide };
              }
            }
          }
        }
        const snappedX = baseX + (bestX?.diff ?? 0);
        const snappedY = baseY + (bestY?.diff ?? 0);
        setAlignGuides({ x: bestX?.guide ?? null, y: bestY?.guide ?? null });

        const movedPositions = new Map<string, { x: number; y: number }>([
          [dragging.nodeID, { x: snappedX, y: snappedY }],
          ...dragging.siblings.map((sibling) => [
            sibling.nodeID,
            { x: snapToGrid(snappedX + sibling.offsetX), y: snapToGrid(snappedY + sibling.offsetY) },
          ] as const),
        ]);

        if (!dragging.elasticDetached) {
          let justActivated = false;
          if (!dragging.elasticOrigin) {
            const movedCard = { id: dragging.nodeID, x: baseX, y: baseY, width: draggedSize.width, height: draggedSize.height };
            // 通过 ref 读取最新 decorations，避免 memo 回调闭包陈旧导致首次拖入无法激活弹性边框
            const origin = activeElasticDecorationForElement(movedCard, decorationsRef.current);
            if (origin) {
              dragging.elasticOrigin = origin;
              dragging.elasticContents = [
                ...nodesRef.current.map((item) => ({
                  ...item,
                  ...movedPositions.get(item.id),
                  ...graphNodeSizeOf(item),
                })),
                ...decorationsRef.current.filter((item) => item.id !== origin.id),
              ].filter((item) => isCanvasElementCenterInside(origin, item));
              dragging.elasticEnteredDuringDrag = true;
              justActivated = true;
            }
          }
          const origin = dragging.elasticOrigin;
          if (origin) {
            const elasticContents = dragging.elasticContents.map((item) => ({ ...item, ...movedPositions.get(item.id) }));
            const elastic = elasticCanvasBounds(origin, elasticContents, ELASTIC_MAX_STRETCH, 24, 72);
            if (!justActivated && shouldDetachElasticBoundary({
              velocity: dragging.elasticEnteredDuringDrag ? 0 : velocity,
              velocityThreshold: ELASTIC_DETACH_VELOCITY,
            })) {
              dragging.elasticDetached = true;
              const movedIDs = new Set(movedPositions.keys());
              const remainingContents = dragging.elasticContents.filter((item) => !movedIDs.has(item.id));
              const remainingBounds = elasticCanvasBounds(origin, remainingContents, ELASTIC_MAX_STRETCH, 24, 72);
              const preview = { id: origin.id, x: remainingBounds.x, y: remainingBounds.y, width: remainingBounds.width, height: remainingBounds.height, tension: 0 };
              elasticPreviewRef.current = preview;
              setElasticPreview(preview);
            } else {
              const preview = { id: origin.id, x: elastic.x, y: elastic.y, width: elastic.width, height: elastic.height, tension: elastic.tension };
              elasticPreviewRef.current = preview;
              setElasticPreview(preview);
            }
          }
        } else {
          // 脱离后同一手势内再次把节点拖回 frame 时重新吸附
          const movedCard = { id: dragging.nodeID, x: baseX, y: baseY, width: draggedSize.width, height: draggedSize.height };
          const origin = activeElasticDecorationForElement(movedCard, decorationsRef.current);
          if (origin) {
            dragging.elasticOrigin = origin;
            dragging.elasticContents = [
              ...nodesRef.current.map((item) => ({
                ...item,
                ...movedPositions.get(item.id),
                ...graphNodeSizeOf(item),
              })),
              ...decorationsRef.current.filter((item) => item.id !== origin.id),
            ].filter((item) => isCanvasElementCenterInside(origin, item));
            dragging.elasticEnteredDuringDrag = true;
            dragging.elasticDetached = false;
          }
        }
        const nextPositions = [
          { nodeID: dragging.nodeID, x: baseX, y: baseY },
          ...dragging.siblings.map((sibling) => ({
            nodeID: sibling.nodeID,
            x: snapToGrid(baseX + sibling.offsetX),
            y: snapToGrid(baseY + sibling.offsetY),
          })),
        ];
        dragging.lastPositions = nextPositions;
        pendingMoveRef.current = nextPositions;
        if (moveFrameRef.current === null) {
          moveFrameRef.current = requestAnimationFrame(() => {
            moveFrameRef.current = null;
            const positions = pendingMoveRef.current;
            pendingMoveRef.current = null;
            if (positions) {
              onMoveNodes(positions);
            }
          });
        }
        return;
      }

      if (marqueeRef.current) {
        const point = toCanvasPoint(event.clientX, event.clientY);
        const next = { ...marqueeRef.current, currentX: point.x, currentY: point.y };
        marqueeRef.current = next;
        setMarquee(next);
        return;
      }

      const panStart = panStartRef.current;
      if (panStart) {
        onViewportChange({
          ...viewportRef.current,
          x: panStart.viewportX + (event.clientX - panStart.x),
          y: panStart.viewportY + (event.clientY - panStart.y),
        });
      }
    },
    [findMagnetAnchor, onBeginNodeMove, onMoveNodes, onViewportChange, toCanvasPoint, updateEdgeHover, updateMagnetAnchor, zoomAt],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) {
        pinchStartRef.current = null;
      }

      // 释放连线拖拽
      if (connectionDragRef.current) {
        finishConnectionDrag(event.clientX, event.clientY);
        return;
      }

      const currentMarquee = marqueeRef.current;
      if (currentMarquee) {
        const left = Math.min(currentMarquee.startX, currentMarquee.currentX);
        const right = Math.max(currentMarquee.startX, currentMarquee.currentX);
        const top = Math.min(currentMarquee.startY, currentMarquee.currentY);
        const bottom = Math.max(currentMarquee.startY, currentMarquee.currentY);
        const hitNodeIDs = nodesRef.current
          .filter((node) => {
            const size = graphNodeSizeOf(node);
            return node.x < right && node.x + size.width > left && node.y < bottom && node.y + size.height > top;
          })
          .map((node) => node.id);
        marqueeRef.current = null;
        setMarquee(null);
        onSelectedNodeIDsChange(
          marqueeAdditiveRef.current
            ? [...new Set([...marqueeBaseSelectionRef.current, ...hitNodeIDs])]
            : hitNodeIDs,
        );
      }

      if (pointersRef.current.size === 0) {
        panStartRef.current = null;
        const dragging = draggingNodeRef.current;
        if (dragging?.active) {
          if (moveFrameRef.current !== null) {
            cancelAnimationFrame(moveFrameRef.current);
            moveFrameRef.current = null;
          }
          const positions = pendingMoveRef.current;
          pendingMoveRef.current = null;
          if (positions) {
            onMoveNodes(positions);
          }
          refreshElasticPreview(dragging);
          clearElasticPreview(true);
          onEndNodeMove();
        }
        document.body.style.userSelect = "";
        draggingNodeRef.current = null;
      }
    },
    [clearElasticPreview, finishConnectionDrag, onEndNodeMove, onMoveNodes, onSelectedNodeIDsChange, refreshElasticPreview],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (interactionLocked || event.target !== event.currentTarget) {
        return;
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const nextViewport = viewportForCanvasKey(event.key, viewportRef.current, rect);
      if (!nextViewport) {
        return;
      }
      event.preventDefault();
      onViewportChange(nextViewport);
    },
    [interactionLocked, onViewportChange],
  );

  const gridSize = 24 * viewport.scale;
  const visibleBounds = React.useMemo(() => {
    const padding = 320 / viewport.scale;
    return {
      left: -viewport.x / viewport.scale - padding,
      top: -viewport.y / viewport.scale - padding,
      right: (containerSize.width - viewport.x) / viewport.scale + padding,
      bottom: (containerSize.height - viewport.y) / viewport.scale + padding,
    };
  }, [containerSize.height, containerSize.width, viewport]);
  const visibleNodes = React.useMemo(
    () => presentableNodes.filter((node) => {
      const size = graphNodeSizeOf(node);
      return selectedSet.has(node.id) ||
        (node.x < visibleBounds.right &&
          node.x + size.width > visibleBounds.left &&
          node.y < visibleBounds.bottom &&
          node.y + size.height > visibleBounds.top);
    }),
    [presentableNodes, selectedSet, visibleBounds],
  );
  const visibleNodeIDs = React.useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);

  // 图连线：贝塞尔曲线 + 生成中流动动画
  const connectionLines = React.useMemo(() => {
    const nodeByID = new Map(presentableNodes.map((node) => [node.id, node]));
    const generatingNodeIDs = new Set(
      presentableNodes
        .filter((node) => node.kind === "generate" && (node.runStatus === "pending" || node.runStatus === "streaming"))
        .map((node) => node.id),
    );
    return displayEdges.flatMap((edge) => {
      const from = nodeByID.get(edge.fromNodeID);
      const to = nodeByID.get(edge.toNodeID);
      if (!from || !to || (!visibleNodeIDs.has(from.id) && !visibleNodeIDs.has(to.id))) {
        return [];
      }
      const fromSize = graphNodeSizeOf(from);
      const toSize = graphNodeSizeOf(to);
      const fromPoint = graphPortCanvasPosition(from, "out", fromSize);
      const toPoint = graphPortCanvasPosition(to, edge.toPort, toSize);
      if (!fromPoint || !toPoint) {
        return [];
      }
      return [{
        id: edge.id,
        path: graphEdgePath(fromPoint, toPoint),
        midpoint: graphEdgeMidpoint(fromPoint, toPoint),
        fromPoint,
        toPoint,
        active: generatingNodeIDs.has(from.id),
      }];
    });
  }, [displayEdges, presentableNodes, visibleNodeIDs]);

  // 删除按钮跟随指针命中连线：按需读取最新连线，避免把 hover 计算塞进渲染依赖
  const connectionLinesRef = React.useRef(connectionLines);
  connectionLinesRef.current = connectionLines;

  // 连线拖拽中的临时路径：源端口 -> 指针位置
  const connectionDragPath = React.useMemo(() => {
    if (!connectionDrag) {
      return null;
    }
    const node = presentableNodes.find((item) => item.id === connectionDrag.fromNodeID);
    if (!node) {
      return null;
    }
    const fromPoint = connectionDrag.origin
      ?? graphPortCanvasPosition(node, connectionDrag.fromPort, graphNodeSizeOf(node));
    if (!fromPoint) {
      return null;
    }
    return {
      path: graphEdgePath(fromPoint, connectionDrag.pointer),
    };
  }, [connectionDrag, presentableNodes]);

  const marqueeRect = marquee
    ? {
      left: Math.min(marquee.startX, marquee.currentX),
      top: Math.min(marquee.startY, marquee.currentY),
      width: Math.abs(marquee.currentX - marquee.startX),
      height: Math.abs(marquee.currentY - marquee.startY),
    }
    : null;

  // 渲染顺序：Section 最底层，Frame/Note 其上，节点渲染于所有装饰之上
  const renderDecorations = [...presentableDecorations].sort((a, b) =>
    decorationLayerRank(a) - decorationLayerRank(b) || (a.zIndex ?? 0) - (b.zIndex ?? 0) || a.id.localeCompare(b.id));

  const renderDecoration = (item: CanvasDecoration) => {
    const preview = elasticPreview?.id === item.id ? elasticPreview : null;
    const bounds = preview ? { ...item, x: preview.x, y: preview.y, width: preview.width, height: preview.height } : item;
    const selected = selectedDecorationIDs.includes(item.id);
    const regionNodeIDs = canvasElementIDsInRegion(bounds, presentableNodes.map(withGraphSize));
    // Frame 计数使用完整列表：折叠时成员被收纳隐藏，徽标仍显示收纳数量
    const containedCount = item.kind === "frame"
      ? nodes.filter((node) => node.frameID === item.id && !absorbedOutputIDs.has(node.id)).length + decorations.filter((decoration) => decoration.frameID === item.id).length
      : regionNodeIDs.size;
    const color = item.color === "amber" ? "border-amber-400/50 bg-amber-300/10" : "border-indigo-400/40 bg-indigo-500/[0.05]";
    return (
      <div
        key={item.id}
        data-canvas-decoration-id={item.id}
        className={cn(
          "absolute border text-foreground transition-[box-shadow,border-color,background-color] duration-200",
          color,
          item.kind === "note" && "rounded-2xl shadow-sm",
          item.kind === "frame" && "rounded-2xl border-dashed",
          selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
          preview && "border-primary shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_55%,transparent),0_0_42px_color-mix(in_oklab,var(--primary)_35%,transparent)]",
        )}
        style={{
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: item.kind === "frame" && item.collapsed ? 48 : bounds.height,
          zIndex: item.zIndex,
          transform: preview ? `scale(${1 + preview.tension * 0.006})` : undefined,
          transformOrigin: "center",
        }}
        // 拖动与选中仅由标题栏触发，组主体不拦截指针，
        // 点击内部区域时事件冒泡到画布容器，按背景处理（平移/框选）
      >
        {/* 内容裁剪层：圆角内滚动裁剪，同时让缩放手柄可以溢出边框 */}
        <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
          <div
            className={cn(
              "relative z-10 flex h-12 cursor-grab select-none items-center gap-2.5 px-3 active:cursor-grabbing",
              item.kind === "frame" && "bg-indigo-500/[0.04]",
              item.kind === "note" && "h-10 border-b border-current/10",
            )}
            onContextMenu={(event) => {
              event.stopPropagation();
              onSelectedDecorationIDsChange([item.id]);
              onSelectedNodeIDsChange([]);
              onSelectedEdgeIDsChange([]);
              openContextMenu(event, "decoration", Boolean(item.locked));
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              const additiveSelection = event.metaKey || event.ctrlKey || event.shiftKey;
              onSelectedDecorationIDsChange(additiveSelection
                ? selectedDecorationIDs.includes(item.id)
                  ? selectedDecorationIDs.filter((id) => id !== item.id)
                  : [...selectedDecorationIDs, item.id]
                : [item.id]);
              if (!additiveSelection) {
                onSelectedNodeIDsChange([]);
                onSelectedEdgeIDsChange([]);
              }
              if (item.locked || additiveSelection) return;
              // 拖动期间全局禁用文本选择：标题栏本身 select-none 时，
              // 浏览器会把选区"跳"到周围可选中文本（其他节点内容）上
              document.body.style.userSelect = "none";
              // pointer capture 让后续指针事件全部重定向到标题栏，
              // 避免划过 textarea 等可编辑内容时浏览器把选区"装"进去
              const headerElement = event.currentTarget;
              headerElement.setPointerCapture?.(event.pointerId);
              const start = { x: event.clientX, y: event.clientY, left: item.x, top: item.y };
              const move = (next: PointerEvent) => {
                window.getSelection()?.removeAllRanges();
                onMoveDecoration(item.id, snapToGrid(start.left + (next.clientX - start.x) / viewport.scale), snapToGrid(start.top + (next.clientY - start.y) / viewport.scale));
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                headerElement.releasePointerCapture?.(event.pointerId);
                document.body.style.userSelect = "";
              };
              window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
            }}
          >
            {item.kind === "frame" ? <Box className="size-4 shrink-0 text-indigo-500" strokeWidth={1.8} /> : null}
            <div className="min-w-0">
              <span className="block truncate text-xs font-semibold uppercase tracking-[0.16em]">{item.title}</span>
              {item.kind === "frame" ? <span className="block truncate text-[9px] font-medium tracking-wide text-muted-foreground">{t("frameInlineHint")}</span> : null}
            </div>
            {item.kind === "frame" ? <span className="ml-auto shrink-0 rounded-full bg-background/60 px-2 py-0.5 text-[9px] font-semibold tabular-nums text-indigo-600 dark:text-indigo-300">{t("frameContainedCount", { count: containedCount })}</span> : null}
            {item.kind === "frame" ? (
              <div data-canvas-selectable className="flex shrink-0 items-center">
                <button
                  type="button"
                  aria-label={t("frameAutoLayout")}
                  title={t("frameAutoLayout")}
                  className="mr-0.5 rounded-md p-1.5 text-muted-foreground hover:bg-indigo-500/10 hover:text-indigo-600"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onArrangeFrame(item.id)}
                >
                  <LayoutGrid className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t(item.collapsed ? "frameExpand" : "frameCollapse")}
                  title={t(item.collapsed ? "frameExpand" : "frameCollapse")}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-indigo-500/10 hover:text-indigo-600"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    onUpdateDecoration(item.id, { collapsed: !item.collapsed });
                    toast.success(t(item.collapsed ? "frameExpanded" : "frameCollapsed"));
                  }}
                >
                  {item.collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
                </button>
              </div>
            ) : null}
            {item.locked ? <LockKeyhole className="size-3.5 shrink-0 opacity-60" /> : null}
          </div>
          {item.kind === "note" ? (
            <textarea
              data-canvas-selectable
              aria-label={item.title}
              className="h-[calc(100%-2.5rem)] w-full resize-none bg-transparent p-3 text-sm leading-relaxed outline-none"
              value={item.text}
              readOnly={item.locked}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => onUpdateDecoration(item.id, { text: event.target.value })}
            />
          ) : null}
        </div>
        {/* 选中且未锁定时显示 8 向缩放手柄；折叠状态下先展开再调整 */}
        {selected && !item.locked && !(item.kind === "frame" && item.collapsed)
          ? DECORATION_HANDLES.map((handle) => (
            <span
              key={handle.id}
              aria-hidden="true"
              className={cn(
                "pointer-events-auto absolute z-20 flex size-4 items-center justify-center",
                handle.className,
                handle.cursor,
              )}
              onPointerDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
                const minSize = item.kind === "note" ? { width: 120, height: 80 } : { width: 160, height: 120 };
                const start = { x: event.clientX, y: event.clientY, left: item.x, top: item.y, width: item.width, height: item.height };
                const apply = (next: PointerEvent) => {
                  const deltaX = (next.clientX - start.x) / viewport.scale;
                  const deltaY = (next.clientY - start.y) / viewport.scale;
                  let { left, top, width, height } = start;
                  if (handle.id.includes("e")) {
                    width = Math.max(minSize.width, start.width + deltaX);
                  }
                  if (handle.id.includes("s")) {
                    height = Math.max(minSize.height, start.height + deltaY);
                  }
                  if (handle.id.includes("w")) {
                    width = Math.max(minSize.width, start.width - deltaX);
                    left = start.left + start.width - width;
                  }
                  if (handle.id.includes("n")) {
                    height = Math.max(minSize.height, start.height - deltaY);
                    top = start.top + start.height - height;
                  }
                  onUpdateDecoration(item.id, {
                    x: snapToGrid(left),
                    y: snapToGrid(top),
                    width: snapToGrid(width),
                    height: snapToGrid(height),
                  });
                };
                const up = () => { window.removeEventListener("pointermove", apply); window.removeEventListener("pointerup", up); };
                window.addEventListener("pointermove", apply); window.addEventListener("pointerup", up);
              }}
            >
              <span className="size-2.5 rounded-[3px] border border-primary bg-background shadow-sm" />
            </span>
          ))
          : null}
      </div>
    );
  };

  // 素材工具栏：仅图片编辑模型可选；模型只影响超清等生成操作
  const imageEditModels = React.useMemo(
    () => imageModels.filter((model) => model.kinds.includes("image_edit")),
    [imageModels],
  );
  const assetToolbarModel = React.useMemo(() => {
    if (imageEditModels.length === 0) {
      return null;
    }
    return imageEditModels.find((item) => canvasModelKey(item) === assetToolbarModelKey) ?? imageEditModels[0];
  }, [assetToolbarModelKey, imageEditModels]);
  const assetToolbarNode = React.useMemo(() => {
    if (!assetToolbarNodeID) {
      return null;
    }
    const node = nodes.find((item) => item.id === assetToolbarNodeID);
    // 视频结果与图片结果同样提供素材操作
    if (!node || !(node.kind === "image" || node.kind === "media" || node.kind === "output")) {
      return null;
    }
    return node;
  }, [assetToolbarNodeID, nodes]);

  // 素材工具栏定位：水平居中对齐素材节点，浮在其上方，上方空间不足时改到下方
  const assetToolbarPosition = React.useMemo(() => {
    if (!assetToolbarNode) {
      return null;
    }
    // 合并进生成卡片的输出结果按父生成节点定位，避免工具栏飞到隐藏节点处
    const anchor = assetToolbarNode.kind === "output" && assetToolbarNode.sourceGenerateID
      ? nodes.find((item) => item.id === assetToolbarNode.sourceGenerateID) ?? assetToolbarNode
      : assetToolbarNode;
    const nodeSize = graphNodeSizeOf(anchor);
    const centerX = (anchor.x + nodeSize.width / 2) * viewport.scale + viewport.x;
    const top = anchor.y * viewport.scale + viewport.y;
    const bottom = (anchor.y + nodeSize.height) * viewport.scale + viewport.y;
    const placeBelow = top < 72;
    // 以节点中心为锚点，左右各留出半宽，避免贴边溢出
    const estimatedWidth = 560;
    const clampedCenter = Math.max(estimatedWidth / 2 + 8, Math.min(centerX, containerSize.width - estimatedWidth / 2 - 8));
    return { center: clampedCenter, top: placeBelow ? bottom + 12 : top - 12, placeBelow };
  }, [assetToolbarNode, containerSize.width, nodes, viewport.scale, viewport.x, viewport.y]);

  // 自定义截帧的目标节点
  const frameCaptureNode = React.useMemo(() => {
    if (!frameCaptureNodeID) {
      return null;
    }
    const node = nodes.find((item) => item.id === frameCaptureNodeID);
    return node && (node.kind === "media" || node.kind === "output") ? node : null;
  }, [frameCaptureNodeID, nodes]);

  // 点击工具栏与素材节点以外的位置时关闭工具栏（失焦关闭）
  React.useEffect(() => {
    if (!assetToolbarNodeID) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest('[data-canvas-ui="asset-toolbar"]')) {
        return;
      }
      // Popover / Dialog 等浮层通过 Portal 渲染，不能算作外部点击
      if (
        target.closest("[data-radix-popper-content-wrapper]")
        || target.closest('[data-slot="popover-content"]')
        || target.closest("[data-canvas-ui]")
      ) {
        return;
      }
      if (target.closest(`[data-canvas-node-id="${assetToolbarNodeID}"]`)) {
        return;
      }
      setAssetToolbarNodeID(null);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [assetToolbarNodeID]);

  // 点击工具栏的改图操作：在节点图上直接进入内联编辑，不再弹开放大编辑面板
  const beginInlineEdit = React.useCallback((node: ImageGraphNode | OutputGraphNode, mode: InlineEditMode) => {
    if (!assetToolbarModel) {
      return;
    }
    setAssetToolbarNodeID(null);
    setInlineEdit({ nodeID: node.id, mode, modelKey: canvasModelKey(assetToolbarModel) });
  }, [assetToolbarModel]);

  // 点击内联编辑区域以外的位置时关闭编辑态
  React.useEffect(() => {
    if (!inlineEdit) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest('[data-canvas-ui="inline-asset-editor"]') || target.closest("[data-canvas-ui]")) {
        return;
      }
      setInlineEdit(null);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [inlineEdit]);

  const inlineEditNode = React.useMemo(() => {
    if (!inlineEdit) {
      return null;
    }
    const node = nodes.find((item) => item.id === inlineEdit.nodeID);
    return node && (node.kind === "image" || node.kind === "output") ? node : null;
  }, [inlineEdit, nodes]);

  const inlineEditModel = React.useMemo(
    () => imageEditModels.find((model) => canvasModelKey(model) === inlineEdit?.modelKey) ?? imageEditModels[0] ?? null,
    [imageEditModels, inlineEdit?.modelKey],
  );

  // 内联编辑覆盖层：与节点预览区对齐，不复制/移动素材
  const inlineEditLayout = React.useMemo(() => {
    if (!inlineEditNode) {
      return null;
    }
    const anchor = inlineEditNode.kind === "output" && inlineEditNode.sourceGenerateID
      ? nodes.find((item) => item.id === inlineEditNode.sourceGenerateID) ?? inlineEditNode
      : inlineEditNode;
    const nodeSize = graphNodeSizeOf(anchor);
    return {
      left: anchor.x * viewport.scale + viewport.x,
      top: (anchor.y + 32) * viewport.scale + viewport.y,
      width: nodeSize.width * viewport.scale,
      height: Math.max(80, (nodeSize.height - 60) * viewport.scale),
    };
  }, [inlineEditNode, nodes, viewport.scale, viewport.x, viewport.y]);

  const inlineEditSource = inlineEditNode
    ? inlineEditNode.kind === "output" ? inlineEditNode.objectURL ?? inlineEditNode.previewURL : inlineEditNode.previewURL
    : undefined;
  const inlineEditName = inlineEditNode
    ? inlineEditNode.kind === "output" ? inlineEditNode.fileName : inlineEditNode.reference?.fileName
    : undefined;

  const runAssetToolbarAction = React.useCallback(
    (
      action: "inpaint" | "outpaint" | "crop" | "upscale" | "extractFrame" | "extractAudio" | "remove",
      tier?: "2K" | "4K",
      frame?: "first" | "last" | "custom",
    ) => {
      const node = assetToolbarNode;
      if (!node) {
        return;
      }
      setAssetToolbarNodeID(null);
      // 执行素材操作时自动关闭生成对话框
      onSelectedNodeIDsChange([]);
      onSelectedDecorationIDsChange([]);
      if (action === "remove") {
        onRemoveNode(node.id);
        return;
      }
      if (node.kind === "image") {
        if (action === "inpaint" || action === "outpaint" || action === "crop") {
          beginInlineEdit(node, action);
          return;
        }
        if (action === "upscale" && assetToolbarModel) {
          onUpscaleAsset(node, tier ?? "2K", assetToolbarModel);
        }
        return;
      }
      if (node.kind === "output") {
        const isVideoOutput = node.mediaType === "video" || Boolean(node.mimeType?.startsWith("video/"));
        if (isVideoOutput) {
          if (action === "extractFrame") {
            if (frame === "custom") {
              setFrameCaptureNodeID(node.id);
            } else {
              onExtractFrame(node, frame);
            }
          } else if (action === "extractAudio") {
            onExtractAudio(node);
          }
          return;
        }
        // 图片结果：改图 / 扩图 / 裁剪 / 超清
        if (action === "inpaint" || action === "outpaint" || action === "crop") {
          beginInlineEdit(node, action);
          return;
        }
        if (action === "upscale" && assetToolbarModel) {
          onUpscaleAsset(node, tier ?? "2K", assetToolbarModel);
        }
        return;
      }
      if (action === "extractFrame") {
        if (frame === "custom") {
          setFrameCaptureNodeID(node.id);
        } else {
          onExtractFrame(node, frame);
        }
      } else if (action === "extractAudio") {
        onExtractAudio(node);
      }
    },
    [assetToolbarModel, assetToolbarNode, onEditReferenceNode, onExtractAudio, onExtractFrame, onRemoveNode, onUpscaleAsset],
  );

  // 时间线片段分割：在指定秒数处把片段拆成前后两段；整段素材按读到的总时长为界
  const handleSplitTimelineSegment = React.useCallback(
    (nodeID: string, segmentID: string, at: number, duration: number, timelineAt?: number) => {
      const node = nodesRef.current.find((item) => item.id === nodeID);
      if (node?.kind !== "timeline") {
        return;
      }
      const target = node.segments.find((segment) => segment.id === segmentID);
      if (!target) {
        return;
      }
      const start = target.end > target.start ? target.start : 0;
      const end = target.end > target.start ? target.end : duration;
      if (!(at > start && at < end)) {
        return;
      }
      const firstTimelineStart = timelineAt === undefined ? target.timelineStart : timelineAt - (at - start);
      const segments = node.segments.flatMap((segment) => segment.id === segmentID
        ? [
          { ...segment, id: createTimelineSegmentID(), start, end: at, timelineStart: firstTimelineStart },
          // 后一半从分割线位置开始，保证时间线位置不变
          {
            ...segment,
            id: createTimelineSegmentID(),
            start: at,
            end,
            timelineStart: timelineAt === undefined ? segment.timelineStart : timelineAt,
          },
        ]
        : [segment]);
      onUpdateNode(nodeID, { segments });
    },
    [onUpdateNode],
  );

  // 时间线片段删除：移除片段；该来源不再有片段时一并移除对应连线
  const handleRemoveTimelineSegment = React.useCallback(
    (nodeID: string, segmentID: string) => {
      const node = nodesRef.current.find((item) => item.id === nodeID);
      if (node?.kind !== "timeline") {
        return;
      }
      const target = node.segments.find((segment) => segment.id === segmentID);
      if (!target) {
        return;
      }
      const remaining = node.segments.filter((segment) => segment.id !== segmentID);
      const track = target.track ?? "video";
      // 自定义轨道按轨道 id 判断类型，内置轨沿用 video / audio
      const trackKind = node.tracks?.find((item) => item.id === track)?.kind
        ?? (track.startsWith("audio") ? "audio" : "video");
      onUpdateNode(nodeID, { segments: remaining });
      if (!remaining.some((segment) => segment.sourceNodeID === target.sourceNodeID && (segment.track ?? "video") === track)) {
        // 只删除对应轨道的那条入边，避免误删同一来源的另一轨连线
        const edge = edges.find((item) =>
          item.fromNodeID === target.sourceNodeID
          && item.toNodeID === nodeID
          && item.toPort === trackKind);
        if (edge) {
          onRemoveEdge(edge.id);
        }
      }
    },
    [edges, onRemoveEdge, onUpdateNode],
  );

  // 时间点在轨道上切分所有跨越该点的片段（点击时间轴时使用）
  const handleSplitTimelineAt = React.useCallback(
    (nodeID: string, at: number, layout: Record<string, { offset: number; duration: number }>) => {
      const node = nodesRef.current.find((item) => item.id === nodeID);
      if (node?.kind !== "timeline") {
        return;
      }
      const next = node.segments.flatMap((segment) => {
        const info = layout[segment.id];
        if (!info) {
          return [segment];
        }
        const { offset, duration } = info;
        if (!(at > offset + 0.05 && at < offset + duration - 0.05)) {
          return [segment];
        }
        // 播放头是时间线秒数：换算成源视频内的切分点
        const sourceStart = segment.end > segment.start ? segment.start : 0;
        const sourceEnd = segment.end > segment.start ? segment.end : sourceStart + duration;
        const sourceAt = sourceStart + (at - offset);
        return [
          { ...segment, id: createTimelineSegmentID(), start: sourceStart, end: sourceAt, timelineStart: offset },
          { ...segment, id: createTimelineSegmentID(), start: sourceAt, end: sourceEnd, timelineStart: at },
        ];
      });
      onUpdateNode(nodeID, { segments: next });
    },
    [onUpdateNode],
  );

  // 时间线 + 菜单：把选中的素材来源连入时间线对应轨道，自动追加片段
  const handleAttachTimelineSource = React.useCallback(
    (timelineNodeID: string, sourceNodeID: string, track: TimelineTrackKind, trackID?: string) => {
      onConnectNodes({
        fromNodeID: sourceNodeID,
        fromPort: "out",
        toNodeID: timelineNodeID,
        toPort: track === "audio" ? "audio" : "video",
        trackID,
      });
    },
    [onConnectNodes],
  );

  const nodeHandlers: GraphNodeActionHandlers = React.useMemo(() => ({
    onUpdateNode,
    onEnsureNodePreview,
    onRemoveNode,
    onRunNode,
    onCancelNode,
    onRequeryNode,
    onRequeryOutputNode,
    onRetryOutputSave,
    onPreviewNode,
    onPreviewResult,
    onDownloadNode,
    onEditNode: (node) => beginInlineEdit(node, "inpaint"),
    onEditReferenceNode,
    onOpenAssetToolbar: (node) => setAssetToolbarNodeID(node.id),
    onSelectNode: (nodeID) => {
      onSelectedNodeIDsChange([nodeID]);
      onSelectedDecorationIDsChange([]);
      onSelectedEdgeIDsChange([]);
    },
    onSplitTimelineSegment: handleSplitTimelineSegment,
    onSplitTimelineAt: handleSplitTimelineAt,
    onRemoveTimelineSegment: handleRemoveTimelineSegment,
    onExportTimeline,
    onAttachTimelineSource: handleAttachTimelineSource,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    onUseAsReference,
    uploadReferenceFile,
  }), [beginInlineEdit, canRedo, canUndo, handleAttachTimelineSource, handleRemoveTimelineSegment, handleSplitTimelineAt, handleSplitTimelineSegment, onCancelNode, onDownloadNode, onEditReferenceNode, onEnsureNodePreview, onExportTimeline, onPreviewNode, onPreviewResult, onRedo, onRemoveNode, onRequeryNode, onRequeryOutputNode, onRetryOutputSave, onRunNode, onSelectedDecorationIDsChange, onSelectedEdgeIDsChange, onSelectedNodeIDsChange, onUndo, onUpdateNode, onUseAsReference, uploadReferenceFile]);

  // 原生文本选择由 mousedown 默认行为启动。在非交互内容上阻止它，
  // 拖动画布 / 节点 / 装饰时就不会选中节点内文本；
  // textarea、input、pre（错误详情）等可编辑/可复制内容保持原生选择。
  // 注意：弹层（模型选择器等 data-canvas-ui 覆盖层）经 Portal 渲染到 body，
  // 但 React 事件仍会沿 React 树冒泡到这里——必须豁免，否则 preventDefault
  // 会阻止弹层内控件获得焦点，状态切换移除焦点元素时 Radix 判定
  // focusOutside 会直接把弹层收起（表现为点「用户模型」Tab 弹层收缩关闭）。
  const handleMouseDownCapture = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (isCanvasOverlayTarget(target)) {
      return;
    }
    if (target.closest("textarea, input, pre, [data-canvas-selectable]") || target.isContentEditable) {
      return;
    }
    event.preventDefault();
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // 右键菜单入口：节点 / 装饰 / 画布背景共用一个面板
  const openContextMenu = React.useCallback((event: React.MouseEvent, kind: CanvasContextMenuState["kind"], locked = false) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setContextMenu({
      x: Math.min(event.clientX - rect.left, Math.max(8, rect.width - 190)),
      y: Math.min(event.clientY - rect.top, Math.max(8, rect.height - 240)),
      kind,
      locked,
    });
  }, []);

  const handleContextAction = React.useCallback((action: CanvasContextAction) => {
    switch (action) {
      case "copy":
        onCopyNodes?.(selectedNodeIDs);
        return;
      case "paste": {
        const rect = containerRef.current?.getBoundingClientRect();
        const point = rect && contextMenu ? toCanvasPoint(rect.left + contextMenu.x, rect.top + contextMenu.y) : undefined;
        onPasteNodes?.(point);
        return;
      }
      case "duplicate":
        onDuplicateNodes(selectedNodeIDs);
        return;
      case "delete":
        if (selectedEdgeIDs.length > 0) {
          for (const edgeID of selectedEdgeIDs) {
            onRemoveEdge(edgeID);
          }
          return;
        }
        onRemoveSelected();
        return;
      case "toggleLock": {
        const nextLocked = !(contextMenu?.locked ?? false);
        for (const nodeID of selectedNodeIDs) {
          onUpdateNode(nodeID, { locked: nextLocked });
        }
        for (const decorationID of selectedDecorationIDs) {
          onUpdateDecoration(decorationID, { locked: nextLocked });
        }
        return;
      }
      case "undo":
        onUndo();
        return;
      case "redo":
        onRedo();
        return;
      case "addFrame":
        onAddDecoration("frame");
        return;
      case "addNote":
        onAddDecoration("note");
        return;
      case "selectAll":
        onSelectedNodeIDsChange(presentableNodes.map((node) => node.id));
        return;
    }
  }, [contextMenu, onAddDecoration, onCopyNodes, onDuplicateNodes, onPasteNodes, onRemoveEdge, onRemoveSelected, onSelectedNodeIDsChange, onUndo, onRedo, onUpdateDecoration, onUpdateNode, presentableNodes, selectedDecorationIDs, selectedEdgeIDs, selectedNodeIDs, toCanvasPoint]);

  // 节点检查器：单选生成节点时在卡片下方展开，随视口缩放/平移重新定位
  const selectedGenerate = React.useMemo<GenerateGraphNode | null>(() => {
    if (selectedNodeIDs.length !== 1) {
      return null;
    }
    const node = nodes.find((item) => item.id === selectedNodeIDs[0]);
    return node?.kind === "generate" ? node : null;
  }, [nodes, selectedNodeIDs]);
  const inspectorVisible = Boolean(selectedGenerate && inspectorDismissedID !== selectedGenerate.id && !interactionLocked);
  const inspectorLayout = React.useMemo(() => {
    if (!selectedGenerate) {
      return null;
    }
    const size = graphNodeSize(selectedGenerate);
    const width = Math.min(680, Math.max(320, containerSize.width - 24));
    const nodeLeft = selectedGenerate.x * viewport.scale + viewport.x;
    const nodeWidth = size.width * viewport.scale;
    const nodeBottom = selectedGenerate.y * viewport.scale + viewport.y + size.height * viewport.scale;
    const left = Math.max(8, Math.min(nodeLeft + nodeWidth / 2 - width / 2, Math.max(8, containerSize.width - width - 8)));
    const top = Math.max(8, Math.min(nodeBottom + 10, Math.max(8, containerSize.height - 360)));
    return { left, top, width };
  }, [containerSize.height, containerSize.width, selectedGenerate, viewport.scale, viewport.x, viewport.y]);
  const inspectorHandlers = React.useMemo(() => ({
    onUpdateNode,
    onRunNode,
    onRemoveEdge,
    onPreviewAsset,
    onAttachAsset,
    uploadReferenceFile,
    onClose: () => setInspectorDismissedID(selectedGenerate?.id ?? null),
  }), [onAttachAsset, onPreviewAsset, onRemoveEdge, onRunNode, onUpdateNode, selectedGenerate?.id, uploadReferenceFile]);

  return (
    <div
      ref={containerRef}
      role="region"
      data-canvas-viewport
      aria-label={t("canvasRegionLabel")}
      tabIndex={interactionLocked ? -1 : 0}
      className={cn(
        "relative h-full w-full touch-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50",
        spacePressed ? "cursor-grab active:cursor-grabbing" : connectionDrag ? "cursor-crosshair" : effectivePointerMode === "select" ? "cursor-crosshair" : "cursor-grab",
      )}
      onKeyDown={handleKeyDown}
      onMouseDownCapture={handleMouseDownCapture}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (isCanvasOverlayTarget(target) || target.closest("[data-canvas-node-id],[data-canvas-decoration-id]")) {
          return;
        }
        onSelectedNodeIDsChange([]);
        onSelectedDecorationIDsChange([]);
        onSelectedEdgeIDsChange([]);
        openContextMenu(event, "canvas");
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDragOver={(event) => {
        // 只接管系统文件拖入；节点间拖动图片使用自定义 MIME，不参与
        if (onImportFiles && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        if (!onImportFiles) {
          return;
        }
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length === 0) {
          return;
        }
        event.preventDefault();
        onImportFiles(files, toCanvasPoint(event.clientX, event.clientY));
      }}
      onPointerLeave={() => {
        updateMagnetAnchor(null);
        updateEdgeHover(null);
        connectionTargetRef.current = null;
        setConnectionTarget(null);
      }}
    >
      {/* 主题感知点阵网格背景 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
          backgroundSize: `${gridSize}px ${gridSize}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          opacity: 0.5,
        }}
      />

      {/* 节点层 */}
      <div
        className="group/edges absolute top-0 left-0 will-change-transform"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: "0 0",
        }}
      >
        {/* 装饰层：Section 最底层，Frame/Note 其上，节点渲染于所有装饰之上 */}
        {renderDecorations.map((item) => renderDecoration(item))}

        {/* 图连线层：贝塞尔曲线 + 删除按钮 */}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute overflow-visible"
          style={{ left: 0, top: 0, width: 1, height: 1 }}
        >
          {connectionLines.map((line) => (
            <path
              key={line.id}
              d={line.path}
              fill="none"
              strokeWidth={2}
              stroke={line.active ? "var(--primary)" : "var(--border)"}
              strokeDasharray={line.active ? "6 6" : undefined}
              className={line.active ? "animate-pulse" : undefined}
              opacity={0.9}
            />
          ))}
          {connectionDragPath ? (
            <path
              d={connectionDragPath.path}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={2}
              strokeDasharray="5 5"
              opacity={0.85}
            />
          ) : null}
        </svg>

        {/* 连线删除按钮：跟随指针显示在线条最近位置，避免固定中点被其他节点遮挡 */}
        {edgeHover ? (
          <button
            type="button"
            aria-label={t("edgeDelete")}
            title={t("edgeDelete")}
            className="absolute z-30 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-background/95 text-muted-foreground shadow-sm transition-colors hover:border-destructive/40 hover:text-destructive"
            style={{ left: edgeHover.x, top: edgeHover.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemoveEdge(edgeHover.edgeID);
              updateEdgeHover(null);
            }}
          >
            <X className="size-2.5" strokeWidth={2} />
          </button>
        ) : null}

        {/* 对齐参考线：水平 / 垂直吸附时显示 */}
        {alignGuides.x !== null ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute z-30 w-px bg-primary/60"
            style={{ left: alignGuides.x, top: -100000, height: 200000 }}
          />
        ) : null}
        {alignGuides.y !== null ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute z-30 h-px bg-primary/60"
            style={{ top: alignGuides.y, left: -100000, width: 200000 }}
          />
        ) : null}

        {visibleNodes.map((node) => (
          <motion.div
            key={node.id}
            data-canvas-node-id={node.id}
            initial={reducedMotion ? false : { opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 24 }}
            className={cn(
              "group-hover/edges:z-10 rounded-2xl transition-shadow",
              // 连线接近节点时高亮目标节点，明确落点
              connectionTarget?.nodeID === node.id
                && "z-20 shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_45%,transparent)]",
            )}
            style={{
              position: "absolute",
              left: node.x,
              top: node.y,
              // 时间线播放或悬停预览时提到最上层，预览画面不被其他节点遮挡
              zIndex: node.kind === "timeline" && (node.playing || node.previewing) ? 60 : node.zIndex ?? 0,
            }}
            onContextMenu={(event) => {
              onSelectedNodeIDsChange([node.id]);
              onSelectedDecorationIDsChange([]);
              onSelectedEdgeIDsChange([]);
              openContextMenu(event, "node", Boolean(node.locked));
            }}
          >
            {node.locked ? <span className="pointer-events-none absolute -top-2 -right-2 z-30 inline-flex rounded-full border border-border/70 bg-background/85 p-1 text-primary shadow-sm backdrop-blur" title={t("lockedState")}><LockKeyhole className="size-3" /></span> : null}
            <GraphNodeView
              node={node}
              selected={selectedSet.has(node.id)}
              connecting={connectionDrag
                ? { kind: connectionDrag.fromKind, port: connectionDrag.fromPort, mediaKind: connectionDrag.fromMediaKind }
                : null}
              resultNode={node.kind === "generate" ? resultByGenerate.get(node.id) ?? null : null}
              timelineSources={node.kind === "timeline" ? timelineSourcesByNode.get(node.id) ?? [] : undefined}
              timelineAttachOptions={node.kind === "timeline" ? timelineAttachOptionsByNode.get(node.id) ?? [] : undefined}
              handlers={nodeHandlers}
            />
          </motion.div>
        ))}

        {/* 连线拖拽：吸附到附近节点时，连接点直接跟随指针显示 */}
        {connectionDrag && connectionTarget ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-40 -translate-x-1/2 -translate-y-1/2"
            style={{ left: connectionDrag.pointer.x, top: connectionDrag.pointer.y }}
          >
            <span className="block size-3 rounded-full bg-primary shadow-[0_0_0_6px_color-mix(in_oklab,var(--primary)_22%,transparent)]" />
          </div>
        ) : null}

        {/* 悬浮连接点：跟随指针吸附在节点边缘，全节点仅此一个连接点 */}
        {magnetAnchor ? (
          <div
            data-canvas-connection-anchor
            data-canvas-connection-node-id={magnetAnchor.nodeID}
            aria-hidden="true"
            className="pointer-events-none absolute z-40 -translate-x-1/2 -translate-y-1/2"
            style={{ left: magnetAnchor.x, top: magnetAnchor.y }}
          >
            <span className="pointer-events-auto flex size-4 cursor-crosshair items-center justify-center">
              <span className="block size-2.5 rounded-full bg-primary shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_22%,transparent)] transition-transform duration-150 hover:scale-125" />
            </span>
          </div>
        ) : null}

        {/* 框选矩形 */}
        {marqueeRect ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-sm border border-primary/70 bg-primary/10"
            style={{
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.width,
              height: marqueeRect.height,
            }}
          />
        ) : null}
      </div>

      {showInspector && inspectorVisible && selectedGenerate && inspectorLayout ? (
        <CanvasNodeInspector
          node={selectedGenerate}
          nodes={nodes}
          edges={edges}
          models={imageModels}
          left={inspectorLayout.left}
          top={inspectorLayout.top}
          width={inspectorLayout.width}
          handlers={inspectorHandlers}
        />
      ) : null}

      {connectionMenu ? (
        <div
          data-canvas-ui="connection-create"
          className="pointer-events-auto absolute z-50 w-44 rounded-xl border border-border/60 bg-background/95 p-1.5 shadow-xl backdrop-blur-xl"
          style={{ left: connectionMenu.screen.x, top: connectionMenu.screen.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("connectionCreateTitle")}
          </p>
          {connectionMenu.options.map((option) => (
            <button
              key={`${option.kind}-${option.mediaType}-${option.toPort}-${option.reverse}`}
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-accent"
              onClick={() => {
                onDropConnection(connectionMenu.drag, connectionMenu.point, option);
                setConnectionMenu(null);
              }}
            >
              {option.reverse
                ? option.kind === "prompt"
                  ? t("connectCreatePrompt")
                  : option.kind === "image"
                    ? t("connectCreateImage")
                    : option.mediaType === "audio"
                      ? t("connectCreateAudio")
                      : t("connectCreateVideo")
                : option.kind === "timeline"
                  ? t("connectCreateTimeline")
                  : option.mediaType === "video"
                    ? t("connectCreateGenerateVideo")
                    : t("connectCreateGenerateImage")}
            </button>
          ))}
        </div>
      ) : null}

      {assetToolbarNode && assetToolbarPosition ? (
        <div
          className={cn(
            "pointer-events-none absolute z-40 -translate-x-1/2",
            assetToolbarPosition.placeBelow ? "" : "-translate-y-full",
          )}
          style={{ left: assetToolbarPosition.center, top: assetToolbarPosition.top }}
        >
          <CanvasAssetToolbar
            kind={assetToolbarNode.kind === "image"
              ? "image"
              : assetToolbarNode.kind === "media"
                ? assetToolbarNode.mediaKind ?? "video"
                : assetToolbarNode.mediaType === "video" || Boolean(assetToolbarNode.mimeType?.startsWith("video/"))
                  ? "video"
                  : "image"}
            models={imageEditModels}
            selectedModel={assetToolbarModel}
            onSelectModel={(model) => setAssetToolbarModelKey(canvasModelKey(model))}
            onAction={runAssetToolbarAction}
          />
        </div>
      ) : null}

      {inlineEdit && inlineEditNode && inlineEditModel && inlineEditSource && inlineEditLayout ? (
        <CanvasInlineAssetEditor
          mode={inlineEdit.mode}
          sourceURL={inlineEditSource}
          fileName={inlineEditName}
          model={inlineEditModel}
          rect={inlineEditLayout}
          busy={inlineBusy}
          onSubmit={async (payload) => {
            setInlineBusy(true);
            const ok = await onSubmitAssetEdit(inlineEdit.nodeID, payload);
            setInlineBusy(false);
            if (ok) {
              setInlineEdit(null);
            }
          }}
        />
      ) : null}

      <CanvasFrameCaptureDialog
        open={frameCaptureNode !== null}
        source={frameCaptureNode
          ? frameCaptureNode.kind === "output"
            ? frameCaptureNode.objectURL ?? frameCaptureNode.previewURL
            : frameCaptureNode.previewURL
          : undefined}
        fileName={frameCaptureNode
          ? frameCaptureNode.kind === "output"
            ? frameCaptureNode.fileName
            : frameCaptureNode.reference?.fileName
          : undefined}
        onConfirm={(seconds) => {
          if (frameCaptureNode) {
            onExtractFrame(frameCaptureNode, seconds);
          }
          setFrameCaptureNodeID(null);
        }}
        onClose={() => setFrameCaptureNodeID(null)}
      />

      <CanvasContextMenu
        state={contextMenu}
        canUndo={canUndo}
        canRedo={canRedo}
        canPaste={canPasteNodes}
        onAction={handleContextAction}
        onClose={() => setContextMenu(null)}
      />

      {children}
    </div>
  );
}
