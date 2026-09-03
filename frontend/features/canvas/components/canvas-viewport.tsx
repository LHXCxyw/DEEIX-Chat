"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Box, ChevronDown, ChevronUp, Focus, LayoutTemplate, LockKeyhole, MousePointer2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";

import type {
  CanvasDecoration,
  CanvasNode,
  CanvasPointerMode,
  CanvasViewport as Viewport,
} from "@/features/canvas/model/canvas-types";
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_UI_ATTRIBUTE,
  snapToGrid,
} from "@/features/canvas/model/canvas-types";
import {
  activeElasticDecorationForElement,
  canvasElementIDsInRegion,
  elasticCanvasBounds,
  isCanvasElementCenterInside,
  shouldDetachElasticBoundary,
  viewportForCanvasKey,
} from "@/features/canvas/model/canvas-interactions";
import { zoomViewportAt } from "@/features/canvas/model/canvas-persist";
import { CanvasNodeCard } from "@/features/canvas/components/canvas-node-card";
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

type ElasticDecorationPreview = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tension: number;
};

const NODE_DRAG_THRESHOLD = 4;
const CANVAS_CARD_DIAGONAL = Math.hypot(CANVAS_NODE_WIDTH, CANVAS_NODE_HEIGHT);
// 弹性拉伸预算与脱离距离：约两个卡片对角线，留足拖出余量
const ELASTIC_RANGE_MULTIPLIER = 2;
const ELASTIC_EXPANSION_BUDGET = Math.ceil(CANVAS_CARD_DIAGONAL * ELASTIC_RANGE_MULTIPLIER);
const ELASTIC_DISTANCE_THRESHOLD = Math.ceil(CANVAS_CARD_DIAGONAL * ELASTIC_RANGE_MULTIPLIER);
// 刻意甩出才触发脱离的瞬时速度阈值（px/ms），普通快拖约 1.5~2.5，避免误脱离
const ELASTIC_DETACH_VELOCITY = 3;

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
// Section 排在最底层（分区背景标记），Frame/Note 依次在上，卡片渲染于所有装饰之上
function decorationLayerRank(item: CanvasDecoration): number {
  return item.kind === "section" ? 0 : 1;
}

type MarqueeState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

// 覆盖层（工具栏 / 输入区 / 小地图）内的滚轮与指针事件不驱动画布
function isCanvasOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof globalThis.Element)) {
    return false;
  }
  return target.closest(`[${CANVAS_UI_ATTRIBUTE}]`) !== null;
}

export function CanvasViewport({
  nodes,
  decorations,
  viewport,
  pointerMode,
  selectedNodeIDs,
  selectedDecorationIDs,
  interactionLocked,
  containerSize,
  onSelectedNodeIDsChange,
  onSelectedDecorationIDsChange,
  onPointerModeChange,
  onUpdateDecoration,
  onMoveDecoration,
  onFocusRegion,
  onViewportChange,
  onBeginNodeMove,
  onMoveNodes,
  onEndNodeMove,
  onRemoveNode,
  onCancelNode,
  onRetryNode,
  onUseAsReference,
  onReuseParameters,
  onRegenerateNode,
  onEditNode,
  onDownloadNode,
  onPreviewNode,
  children,
}: {
  nodes: CanvasNode[];
  decorations: CanvasDecoration[];
  viewport: Viewport;
  pointerMode: CanvasPointerMode;
  selectedNodeIDs: string[];
  selectedDecorationIDs: string[];
  interactionLocked?: boolean;
  containerSize: { width: number; height: number };
  onSelectedNodeIDsChange: (nodeIDs: string[]) => void;
  onSelectedDecorationIDsChange: (ids: string[]) => void;
  onPointerModeChange: (mode: CanvasPointerMode) => void;
  onUpdateDecoration: (id: string, patch: Partial<CanvasDecoration>) => void;
  onMoveDecoration: (id: string, x: number, y: number) => void;
  onFocusRegion: (region: CanvasDecoration) => void;
  onViewportChange: (viewport: Viewport | ((current: Viewport) => Viewport)) => void;
  onBeginNodeMove: () => void;
  onMoveNodes: (positions: { nodeID: string; x: number; y: number }[]) => void;
  onEndNodeMove: () => void;
  onRemoveNode: (nodeID: string) => void;
  onCancelNode: (nodeID: string) => void;
  onRetryNode: (nodeID: string) => void;
  onUseAsReference: (node: CanvasNode) => void;
  onReuseParameters: (node: CanvasNode) => void;
  onRegenerateNode: (node: CanvasNode) => void;
  onEditNode: (node: CanvasNode) => void;
  onDownloadNode: (node: CanvasNode) => void;
  onPreviewNode: (node: CanvasNode) => void;
  children?: React.ReactNode;
}) {
  const t = useTranslations("canvas");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();
  const pointersRef = React.useRef(new Map<number, ActivePointer>());
  const panStartRef = React.useRef<{ x: number; y: number; viewportX: number; viewportY: number } | null>(null);
  const pinchStartRef = React.useRef<{ distance: number; scale: number } | null>(null);
  const draggingNodeRef = React.useRef<DraggingNodeState | null>(null);
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
  const moveFrameRef = React.useRef<number | null>(null);
  const pendingMoveRef = React.useRef<{ nodeID: string; x: number; y: number }[] | null>(null);

  // 折叠 Frame 的成员卡片与内嵌装饰收纳隐藏，展开后按原位还原
  const collapsedFrameIDs = React.useMemo(
    () => new Set(decorations.filter((item) => item.kind === "frame" && item.collapsed).map((item) => item.id)),
    [decorations],
  );
  const presentableNodes = React.useMemo(
    () => collapsedFrameIDs.size === 0
      ? nodes
      : nodes.filter((node) => !node.frameID || !collapsedFrameIDs.has(node.frameID)),
    [nodes, collapsedFrameIDs],
  );
  const presentableDecorations = React.useMemo(
    () => collapsedFrameIDs.size === 0
      ? decorations
      : decorations.filter((item) => !item.frameID || !collapsedFrameIDs.has(item.frameID)),
    [decorations, collapsedFrameIDs],
  );

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
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") {
        onPointerModeChange("select");
        toast(t("modeSelectActivated"));
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "h") {
        onPointerModeChange("pan");
        toast(t("modePanActivated"));
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
  }, [onPointerModeChange, t]);

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
    const bounds = elasticCanvasBounds(dragging.elasticOrigin, contents, ELASTIC_EXPANSION_BUDGET, 24, 72);
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

  // 指针在容器外释放时兜底清理，避免平移/拖拽状态残留
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

  // 滚轮固定为缩放；覆盖层与锁定状态下不处理，避免下拉选择器影响画布
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (interactionLockedRef.current || isCanvasOverlayTarget(event.target)) {
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

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (interactionLocked || isCanvasOverlayTarget(event.target)) {
        return;
      }
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
      // 卡片内可选中/可交互区域不触发拖拽，保证文本选择与右键复制
      if (target.closest("[data-canvas-selectable]")) {
        return;
      }
      const nodeElement = target.closest("[data-canvas-node-id]") as HTMLElement | null;
      const nodeID = nodeElement?.dataset.canvasNodeId ?? "";
      const node = nodes.find((item) => item.id === nodeID);
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
        const explicitSelection = selectedRef.current.includes(nodeID) ? selectedRef.current : [nodeID];
        const groupSelection = node.groupID ? [...new Set([...explicitSelection, ...presentableNodes.filter((item) => item.groupID === node.groupID).map((item) => item.id)])] : explicitSelection;
        const elasticOrigin = presentableDecorations
          .filter((item) => (item.kind === "frame" || item.kind === "section") && !item.locked)
          .filter((item) => isCanvasElementCenterInside(item, { ...node, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }))
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
              ...presentableNodes.map((item) => ({ ...item, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT })),
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
        // 轻点时不抢占 pointer capture，保证卡片内图片按钮能收到 click；
        // 指针移动超过阈值后再进入正式拖拽。
        return;
      }

      // 框选模式下拖拽背景绘制选框；中键始终平移
      if (pointerMode === "select" && !isMiddleButton && !temporaryPan) {
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
      }
      containerRef.current?.setPointerCapture?.(event.pointerId);
    },
    [interactionLocked, onSelectedDecorationIDsChange, onSelectedNodeIDsChange, pointerMode, presentableDecorations, presentableNodes, toCanvasPoint],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
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

        const movedPositions = new Map<string, { x: number; y: number }>([
          [dragging.nodeID, { x: baseX, y: baseY }],
          ...dragging.siblings.map((sibling) => [
            sibling.nodeID,
            { x: snapToGrid(baseX + sibling.offsetX), y: snapToGrid(baseY + sibling.offsetY) },
          ] as const),
        ]);

        if (!dragging.elasticDetached) {
          let justActivated = false;
          if (!dragging.elasticOrigin) {
            const movedCard = { id: dragging.nodeID, x: baseX, y: baseY, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT };
            // 通过 ref 读取最新 decorations，避免 memo 回调闭包陈旧导致首次拖入无法激活弹性边框
            const origin = activeElasticDecorationForElement(movedCard, decorationsRef.current);
            if (origin) {
              dragging.elasticOrigin = origin;
              dragging.elasticContents = [
                ...nodesRef.current.map((item) => ({
                  ...item,
                  ...movedPositions.get(item.id),
                  width: CANVAS_NODE_WIDTH,
                  height: CANVAS_NODE_HEIGHT,
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
            const elastic = elasticCanvasBounds(origin, elasticContents, ELASTIC_EXPANSION_BUDGET, 24, 72);
            // 卡片相对原始 frame 的最大超出距离：完全在 frame 内时为 0，避免靠近边缘即误判脱离
            const cardOverflow = Math.max(
              baseX - origin.x,
              baseY - origin.y,
              origin.x + origin.width - (baseX + CANVAS_NODE_WIDTH),
              origin.y + origin.height - (baseY + CANVAS_NODE_HEIGHT),
              0,
            );
            if (!justActivated && shouldDetachElasticBoundary({
              overflowDistance: cardOverflow,
              velocity: dragging.elasticEnteredDuringDrag ? 0 : velocity,
              requestedExpansion: elastic.requestedExpansion,
              expansionBudget: ELASTIC_EXPANSION_BUDGET,
              distanceThreshold: ELASTIC_DISTANCE_THRESHOLD / viewportRef.current.scale,
              velocityThreshold: ELASTIC_DETACH_VELOCITY,
            })) {
              dragging.elasticDetached = true;
              const movedIDs = new Set(movedPositions.keys());
              const remainingContents = dragging.elasticContents.filter((item) => !movedIDs.has(item.id));
              const remainingBounds = elasticCanvasBounds(origin, remainingContents, ELASTIC_EXPANSION_BUDGET, 24, 72);
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
          // 脱离后同一手势内再次把卡片拖回 frame 时重新吸附
          const movedCard = { id: dragging.nodeID, x: baseX, y: baseY, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT };
          const origin = activeElasticDecorationForElement(movedCard, decorationsRef.current);
          if (origin) {
            dragging.elasticOrigin = origin;
            dragging.elasticContents = [
              ...nodesRef.current.map((item) => ({
                ...item,
                ...movedPositions.get(item.id),
                width: CANVAS_NODE_WIDTH,
                height: CANVAS_NODE_HEIGHT,
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
    [onBeginNodeMove, onMoveNodes, onViewportChange, toCanvasPoint, zoomAt],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) {
        pinchStartRef.current = null;
      }

      const currentMarquee = marqueeRef.current;
      if (currentMarquee) {
        const left = Math.min(currentMarquee.startX, currentMarquee.currentX);
        const right = Math.max(currentMarquee.startX, currentMarquee.currentX);
        const top = Math.min(currentMarquee.startY, currentMarquee.currentY);
        const bottom = Math.max(currentMarquee.startY, currentMarquee.currentY);
        const hitNodeIDs = nodesRef.current
          .filter(
            (node) =>
              node.x < right &&
              node.x + CANVAS_NODE_WIDTH > left &&
              node.y < bottom &&
              node.y + CANVAS_NODE_HEIGHT > top,
          )
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
        draggingNodeRef.current = null;
      }
    },
    [clearElasticPreview, onEndNodeMove, onMoveNodes, onSelectedNodeIDsChange, refreshElasticPreview],
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
    () => presentableNodes.filter((node) =>
      selectedSet.has(node.id) ||
      (node.x < visibleBounds.right &&
        node.x + CANVAS_NODE_WIDTH > visibleBounds.left &&
        node.y < visibleBounds.bottom &&
        node.y + CANVAS_NODE_HEIGHT > visibleBounds.top),
    ),
    [presentableNodes, selectedSet, visibleBounds],
  );
  const visibleNodeIDs = React.useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);

  // 父子连接线：由父节点底部中点连向子节点顶部中点
  const connections = React.useMemo(() => {
    const nodeByID = new Map(presentableNodes.map((node) => [node.id, node]));
    return presentableNodes.flatMap((node) => {
      const parent = node.parentID ? nodeByID.get(node.parentID) : undefined;
      if (!parent || (!visibleNodeIDs.has(node.id) && !visibleNodeIDs.has(parent.id))) {
        return [];
      }
      const fromX = parent.x + CANVAS_NODE_WIDTH;
      const fromY = parent.y + CANVAS_NODE_HEIGHT / 2;
      const toX = node.x;
      const toY = node.y + CANVAS_NODE_HEIGHT / 2;
      const controlOffset = Math.max(48, Math.abs(toX - fromX) / 2);
      return [
        {
          id: `${parent.id}->${node.id}`,
          path: `M ${fromX} ${fromY} C ${fromX + controlOffset} ${fromY}, ${toX - controlOffset} ${toY}, ${toX} ${toY}`,
          active: node.status === "pending" || node.status === "streaming",
        },
      ];
    });
  }, [presentableNodes, visibleNodeIDs]);

  const marqueeRect = marquee
    ? {
      left: Math.min(marquee.startX, marquee.currentX),
      top: Math.min(marquee.startY, marquee.currentY),
      width: Math.abs(marquee.currentX - marquee.startX),
      height: Math.abs(marquee.currentY - marquee.startY),
    }
    : null;

  // 渲染顺序：Section 最底层，Frame/Note 其上，卡片渲染于所有装饰之上
  const renderDecorations = [...presentableDecorations].sort((a, b) =>
    decorationLayerRank(a) - decorationLayerRank(b) || (a.zIndex ?? 0) - (b.zIndex ?? 0) || a.id.localeCompare(b.id));

  const renderDecoration = (item: CanvasDecoration) => {
    const preview = elasticPreview?.id === item.id ? elasticPreview : null;
    const bounds = preview ? { ...item, x: preview.x, y: preview.y, width: preview.width, height: preview.height } : item;
    const selected = selectedDecorationIDs.includes(item.id);
    const regionNodeIDs = canvasElementIDsInRegion(bounds, presentableNodes.map((node) => ({ ...node, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT })));
    // Frame 计数使用完整列表：折叠时成员被收纳隐藏，徽标仍显示收纳数量
    const containedCount = item.kind === "frame"
      ? nodes.filter((node) => node.frameID === item.id).length + decorations.filter((decoration) => decoration.frameID === item.id).length
      : regionNodeIDs.size;
    const color = item.color === "amber" ? "border-amber-400/60 bg-amber-300/15" : item.color === "cyan" ? "border-cyan-400/35 bg-cyan-400/[0.025]" : "border-indigo-400/70 bg-indigo-500/[0.08]";
    return (
      <div
        key={item.id}
        data-canvas-decoration-id={item.id}
        className={cn(
          "absolute border text-foreground transition-[box-shadow,border-color,background-color] duration-200",
          color,
          item.kind === "note" && "rounded-2xl shadow-sm",
          item.kind === "section" && "rounded-[32px] border-dashed shadow-none",
          item.kind === "frame" && "rounded-2xl border-2 shadow-[0_20px_70px_-42px_rgba(79,70,229,0.75)] before:pointer-events-none before:absolute before:inset-2 before:rounded-xl before:border before:border-indigo-400/15",
          selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
          preview && "border-primary shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_55%,transparent),0_0_42px_color-mix(in_oklab,var(--primary)_35%,transparent)]",
        )}
        style={{
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: (item.kind === "frame" || item.kind === "section") && item.collapsed ? 48 : bounds.height,
          zIndex: item.zIndex,
          transform: preview ? `scale(${1 + preview.tension * 0.006})` : undefined,
          transformOrigin: "center",
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          const additiveSelection = event.metaKey || event.ctrlKey || event.shiftKey;
          onSelectedDecorationIDsChange(additiveSelection
            ? selectedDecorationIDs.includes(item.id)
              ? selectedDecorationIDs.filter((id) => id !== item.id)
              : [...selectedDecorationIDs, item.id]
            : [item.id]);
          if (!additiveSelection) onSelectedNodeIDsChange([]);
          if (item.locked || additiveSelection) return;
          const start = { x: event.clientX, y: event.clientY, left: item.x, top: item.y };
          const move = (next: PointerEvent) => onMoveDecoration(item.id, snapToGrid(start.left + (next.clientX - start.x) / viewport.scale), snapToGrid(start.top + (next.clientY - start.y) / viewport.scale));
          const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
          window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
        }}
      >
        {/* 内容裁剪层：圆角内滚动裁剪，同时让缩放手柄可以溢出边框 */}
        <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
          <div className={cn(
            "relative z-10 flex h-12 items-center gap-2.5 px-3",
            item.kind === "frame" && "border-b border-indigo-400/20 bg-indigo-500/[0.08]",
            item.kind === "section" && "border-b border-dashed border-cyan-400/20 bg-background/25",
            item.kind === "note" && "h-10 border-b border-current/10",
          )}>
            {item.kind === "frame" ? <Box className="size-4 shrink-0 text-indigo-500" strokeWidth={1.8} /> : null}
            {item.kind === "section" ? <LayoutTemplate className="size-4 shrink-0 text-cyan-500" strokeWidth={1.8} /> : null}
            <div className="min-w-0">
              <span className="block truncate text-xs font-semibold uppercase tracking-[0.16em]">{item.title}</span>
              {item.kind !== "note" ? <span className="block truncate text-[9px] font-medium tracking-wide text-muted-foreground">{t(item.kind === "frame" ? "frameInlineHint" : "sectionInlineHint")}</span> : null}
            </div>
            {item.kind === "frame" ? <span className="ml-auto shrink-0 rounded-full border border-indigo-400/25 bg-background/60 px-2 py-0.5 text-[9px] font-semibold tabular-nums text-indigo-600 dark:text-indigo-300">{t("frameContainedCount", { count: containedCount })}</span> : null}
            {item.kind === "frame" ? (
              <div data-canvas-selectable className="flex shrink-0 items-center">
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
            {item.kind === "section" ? (
              <div data-canvas-selectable className="ml-auto flex shrink-0 items-center gap-1">
                <span className="mr-1 rounded-full border border-cyan-400/25 bg-background/60 px-2 py-0.5 text-[9px] font-semibold tabular-nums text-cyan-700 dark:text-cyan-300">{t("sectionElementCount", { count: containedCount })}</span>
                <button type="button" aria-label={t("sectionSelectRegion")} title={t("sectionSelectRegion")} className="rounded-md p-1.5 text-muted-foreground hover:bg-cyan-500/10 hover:text-cyan-600" onPointerDown={(event) => event.stopPropagation()} onClick={() => { onSelectedNodeIDsChange([...regionNodeIDs]); onSelectedDecorationIDsChange([]); toast.success(t("sectionSelected", { count: containedCount })); }}><MousePointer2 className="size-3.5" /></button>
                <button type="button" aria-label={t("sectionFocusRegion")} title={t("sectionFocusRegion")} className="rounded-md p-1.5 text-muted-foreground hover:bg-cyan-500/10 hover:text-cyan-600" onPointerDown={(event) => event.stopPropagation()} onClick={() => { onFocusRegion(item); toast.success(t("sectionFocused")); }}><Focus className="size-3.5" /></button>
                <button type="button" aria-label={t(item.collapsed ? "sectionExpand" : "sectionCollapse")} title={t(item.collapsed ? "sectionExpand" : "sectionCollapse")} className="rounded-md p-1.5 text-muted-foreground hover:bg-cyan-500/10 hover:text-cyan-600" onPointerDown={(event) => event.stopPropagation()} onClick={() => { onUpdateDecoration(item.id, { collapsed: !item.collapsed }); toast.success(t(item.collapsed ? "sectionExpanded" : "sectionCollapsed")); }}>{item.collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}</button>
              </div>
            ) : null}
            {item.locked ? <LockKeyhole className={cn("size-3.5 shrink-0 opacity-60", item.kind !== "section" && "ml-auto")} /> : null}
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
        {selected && !item.locked && !((item.kind === "frame" || item.kind === "section") && item.collapsed)
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

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t("canvasRegionLabel")}
      tabIndex={interactionLocked ? -1 : 0}
      className={cn(
        "relative h-full w-full touch-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50",
        spacePressed ? "cursor-grab active:cursor-grabbing" : pointerMode === "select" ? "cursor-crosshair" : "cursor-grab",
      )}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
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
        className="absolute top-0 left-0 will-change-transform"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: "0 0",
        }}
      >
        {/* 装饰层：Section 最底层，Frame/Note 其上，卡片渲染于所有装饰之上 */}
        {renderDecorations.map((item) => renderDecoration(item))}

        {/* 父子连接线（置于卡片之下） */}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute overflow-visible"
          style={{ left: 0, top: 0, width: 1, height: 1 }}
        >
          {connections.map((connection) => (
            <path
              key={connection.id}
              d={connection.path}
              fill="none"
              stroke="var(--border)"
              strokeWidth={2}
              strokeDasharray={connection.active ? "6 6" : undefined}
              className={connection.active ? "animate-pulse" : undefined}
              opacity={0.9}
            />
          ))}
        </svg>

        {visibleNodes.map((node) => (
          <motion.div
            key={node.id}
            data-canvas-node-id={node.id}
            initial={reducedMotion ? false : { opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 24 }}
            style={{
              position: "absolute",
              left: node.x,
              top: node.y,
              width: CANVAS_NODE_WIDTH,
              zIndex: node.zIndex ?? 0,
            }}
          >
            {node.locked ? <span className="pointer-events-none absolute right-2 top-2 z-20 inline-flex rounded-full border border-border/70 bg-background/85 p-1.5 text-primary shadow-sm backdrop-blur" title={t("lockedState")}><LockKeyhole className="size-3.5" /></span> : null}
            <CanvasNodeCard
              node={node}
              selected={selectedSet.has(node.id)}
              onRemove={() => onRemoveNode(node.id)}
              onCancel={() => onCancelNode(node.id)}
              onRetry={() => onRetryNode(node.id)}
              onUseAsReference={() => onUseAsReference(node)}
              onReuseParameters={() => onReuseParameters(node)}
              onRegenerate={() => onRegenerateNode(node)}
              onEdit={() => onEditNode(node)}
              onDownload={() => onDownloadNode(node)}
              onPreview={() => onPreviewNode(node)}
            />
          </motion.div>
        ))}

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

      {children}
    </div>
  );
}
