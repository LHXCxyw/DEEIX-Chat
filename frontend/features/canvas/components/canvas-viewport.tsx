"use client";

import * as React from "react";
import { motion } from "motion/react";

import type {
  CanvasNode,
  CanvasPointerMode,
  CanvasViewport as Viewport,
} from "@/features/canvas/model/canvas-types";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_UI_ATTRIBUTE,
  snapToGrid,
} from "@/features/canvas/model/canvas-types";
import { clampViewportScale } from "@/features/canvas/model/canvas-persist";
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
  active: boolean;
  captureTarget: HTMLElement;
  // 多选批量拖动时记录各节点相对拖拽节点的偏移
  siblings: { nodeID: string; offsetX: number; offsetY: number }[];
};

const NODE_DRAG_THRESHOLD = 4;

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
  viewport,
  pointerMode,
  selectedNodeIDs,
  interactionLocked,
  onSelectedNodeIDsChange,
  onViewportChange,
  onMoveNodes,
  onRemoveNode,
  onCancelNode,
  onRetryNode,
  onUseAsReference,
  onDownloadNode,
  onPreviewNode,
  children,
}: {
  nodes: CanvasNode[];
  viewport: Viewport;
  pointerMode: CanvasPointerMode;
  selectedNodeIDs: string[];
  interactionLocked?: boolean;
  onSelectedNodeIDsChange: (nodeIDs: string[]) => void;
  onViewportChange: (viewport: Viewport | ((current: Viewport) => Viewport)) => void;
  onMoveNodes: (positions: { nodeID: string; x: number; y: number }[]) => void;
  onRemoveNode: (nodeID: string) => void;
  onCancelNode: (nodeID: string) => void;
  onRetryNode: (nodeID: string) => void;
  onUseAsReference: (node: CanvasNode) => void;
  onDownloadNode: (node: CanvasNode) => void;
  onPreviewNode: (node: CanvasNode) => void;
  children?: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const pointersRef = React.useRef(new Map<number, ActivePointer>());
  const panStartRef = React.useRef<{ x: number; y: number; viewportX: number; viewportY: number } | null>(null);
  const pinchStartRef = React.useRef<{ distance: number; scale: number } | null>(null);
  const draggingNodeRef = React.useRef<DraggingNodeState | null>(null);
  const viewportRef = React.useRef(viewport);
  const nodesRef = React.useRef(nodes);
  const selectedRef = React.useRef(selectedNodeIDs);
  const interactionLockedRef = React.useRef(Boolean(interactionLocked));
  const [marquee, setMarquee] = React.useState<MarqueeState | null>(null);
  const marqueeRef = React.useRef<MarqueeState | null>(null);

  React.useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  React.useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  React.useEffect(() => {
    selectedRef.current = selectedNodeIDs;
  }, [selectedNodeIDs]);

  React.useEffect(() => {
    interactionLockedRef.current = Boolean(interactionLocked);
  }, [interactionLocked]);

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
      const scale = clampViewportScale(nextScale, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE);
      const pivotX = clientX - rect.left;
      const pivotY = clientY - rect.top;
      const canvasX = (pivotX - current.x) / current.scale;
      const canvasY = (pivotY - current.y) / current.scale;
      onViewportChange({
        x: pivotX - canvasX * scale,
        y: pivotY - canvasY * scale,
        scale,
      });
    },
    [onViewportChange],
  );

  // 指针在容器外释放时兜底清理，避免平移/拖拽状态残留
  React.useEffect(() => {
    const handleWindowPointerUp = () => {
      pointersRef.current.clear();
      pinchStartRef.current = null;
      panStartRef.current = null;
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
  }, []);

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
      if (node && nodeElement && !isMiddleButton) {
        const point = toCanvasPoint(event.clientX, event.clientY);
        const groupSelection = selectedRef.current.includes(nodeID) ? selectedRef.current : [nodeID];
        draggingNodeRef.current = {
          nodeID,
          offsetX: point.x - node.x,
          offsetY: point.y - node.y,
          startClientX: event.clientX,
          startClientY: event.clientY,
          active: false,
          captureTarget: nodeElement,
          siblings: groupSelection
            .filter((id) => id !== nodeID)
            .flatMap((id) => {
              const sibling = nodes.find((item) => item.id === id);
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
      if (pointerMode === "select" && !isMiddleButton) {
        const point = toCanvasPoint(event.clientX, event.clientY);
        const next = { startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
        marqueeRef.current = next;
        setMarquee(next);
        onSelectedNodeIDsChange([]);
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
      onSelectedNodeIDsChange([]);
      containerRef.current?.setPointerCapture?.(event.pointerId);
    },
    [interactionLocked, nodes, onSelectedNodeIDsChange, pointerMode, toCanvasPoint],
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
          dragging.captureTarget.setPointerCapture?.(event.pointerId);
        }
        const point = toCanvasPoint(event.clientX, event.clientY);
        const baseX = snapToGrid(point.x - dragging.offsetX);
        const baseY = snapToGrid(point.y - dragging.offsetY);
        onMoveNodes([
          { nodeID: dragging.nodeID, x: baseX, y: baseY },
          ...dragging.siblings.map((sibling) => ({
            nodeID: sibling.nodeID,
            x: snapToGrid(baseX + sibling.offsetX),
            y: snapToGrid(baseY + sibling.offsetY),
          })),
        ]);
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
    [onMoveNodes, onViewportChange, toCanvasPoint, zoomAt],
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
        onSelectedNodeIDsChange(hitNodeIDs);
      }

      if (pointersRef.current.size === 0) {
        panStartRef.current = null;
        draggingNodeRef.current = null;
      }
    },
    [onSelectedNodeIDsChange],
  );

  const gridSize = 24 * viewport.scale;

  // 父子连接线：由父节点底部中点连向子节点顶部中点
  const connections = React.useMemo(() => {
    const nodeByID = new Map(nodes.map((node) => [node.id, node]));
    return nodes.flatMap((node) => {
      const parent = node.parentID ? nodeByID.get(node.parentID) : undefined;
      if (!parent) {
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
  }, [nodes]);

  const marqueeRect = marquee
    ? {
      left: Math.min(marquee.startX, marquee.currentX),
      top: Math.min(marquee.startY, marquee.currentY),
      width: Math.abs(marquee.currentX - marquee.startX),
      height: Math.abs(marquee.currentY - marquee.startY),
    }
    : null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-full w-full touch-none overflow-hidden",
        pointerMode === "select" ? "cursor-crosshair" : "cursor-grab",
      )}
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

        {nodes.map((node) => (
          <motion.div
            key={node.id}
            data-canvas-node-id={node.id}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            style={{
              position: "absolute",
              left: node.x,
              top: node.y,
              width: CANVAS_NODE_WIDTH,
            }}
          >
            <CanvasNodeCard
              node={node}
              selected={selectedSet.has(node.id)}
              onRemove={() => onRemoveNode(node.id)}
              onCancel={() => onCancelNode(node.id)}
              onRetry={() => onRetryNode(node.id)}
              onUseAsReference={() => onUseAsReference(node)}
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
