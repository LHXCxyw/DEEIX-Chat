"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Map as MapIcon } from "lucide-react";

import type { CanvasNode, CanvasViewport } from "@/features/canvas/model/canvas-types";
import { CANVAS_NODE_HEIGHT, CANVAS_NODE_WIDTH } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

const MINIMAP_WIDTH = 176;
const MINIMAP_HEIGHT = 120;
const MINIMAP_PADDING = 8;
const MINIMAP_HEADER_HEIGHT = 27;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type MinimapTransform = { bounds: Bounds; offsetX: number; offsetY: number; scale: number };
type MinimapPosition = { left: number; top: number };

function resolveBounds(nodes: CanvasNode[], viewportBox: Bounds): Bounds {
  const bounds = nodes.reduce<Bounds>(
    (current, node) => ({
      minX: Math.min(current.minX, node.x),
      minY: Math.min(current.minY, node.y),
      maxX: Math.max(current.maxX, node.x + CANVAS_NODE_WIDTH),
      maxY: Math.max(current.maxY, node.y + CANVAS_NODE_HEIGHT),
    }),
    { ...viewportBox },
  );
  return {
    minX: bounds.minX - 120,
    minY: bounds.minY - 120,
    maxX: bounds.maxX + 120,
    maxY: bounds.maxY + 120,
  };
}

export function CanvasMinimap({
  nodes,
  viewport,
  containerSize,
  selectedNodeIDs,
  onNavigate,
}: {
  nodes: CanvasNode[];
  viewport: CanvasViewport;
  containerSize: { width: number; height: number };
  selectedNodeIDs: string[];
  // 目标为画布坐标，将其居中显示到视口中心
  onNavigate: (canvasPoint: { x: number; y: number }) => void;
}) {
  const t = useTranslations("canvas");
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);
  const dragTransformRef = React.useRef<MinimapTransform | null>(null);
  const dragOffsetRef = React.useRef({ x: 0, y: 0 });
  const [position, setPosition] = React.useState<MinimapPosition | null>(null);
  const selectedSet = React.useMemo(() => new Set(selectedNodeIDs), [selectedNodeIDs]);

  const viewportBox = React.useMemo<Bounds>(() => {
    const width = containerSize.width > 0 ? containerSize.width : MINIMAP_WIDTH;
    const height = containerSize.height > 0 ? containerSize.height : MINIMAP_HEIGHT;
    return {
      minX: -viewport.x / viewport.scale,
      minY: -viewport.y / viewport.scale,
      maxX: (-viewport.x + width) / viewport.scale,
      maxY: (-viewport.y + height) / viewport.scale,
    };
  }, [containerSize.height, containerSize.width, viewport]);

  const bounds = React.useMemo(() => resolveBounds(nodes, viewportBox), [nodes, viewportBox]);
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const innerWidth = MINIMAP_WIDTH - MINIMAP_PADDING * 2;
  const innerHeight = MINIMAP_HEIGHT - MINIMAP_PADDING * 2;
  const scale = Math.min(innerWidth / boundsWidth, innerHeight / boundsHeight);
  const offsetX = MINIMAP_PADDING + (innerWidth - boundsWidth * scale) / 2;
  const offsetY = MINIMAP_PADDING + (innerHeight - boundsHeight * scale) / 2;

  const toMinimapRect = React.useCallback(
    (x: number, y: number, width: number, height: number) => ({
      left: offsetX + (x - bounds.minX) * scale,
      top: offsetY + (y - bounds.minY) * scale,
      width: Math.max(2, width * scale),
      height: Math.max(2, height * scale),
    }),
    [bounds.minX, bounds.minY, offsetX, offsetY, scale],
  );

  const navigateFromEvent = React.useCallback(
    (clientX: number, clientY: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const transform = dragTransformRef.current ?? { bounds, offsetX, offsetY, scale };
      if (!rect || transform.scale <= 0) {
        return;
      }
      onNavigate({
        x: transform.bounds.minX + (clientX - rect.left - transform.offsetX) / transform.scale,
        y: transform.bounds.minY + (clientY - rect.top - transform.offsetY) / transform.scale,
      });
    },
    [bounds, offsetX, offsetY, onNavigate, scale],
  );

  const viewportRect = toMinimapRect(
    viewportBox.minX,
    viewportBox.minY,
    viewportBox.maxX - viewportBox.minX,
    viewportBox.maxY - viewportBox.minY,
  );

  const handlePanelPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = panelRef.current?.parentElement?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const maxLeft = Math.max(0, containerSize.width - MINIMAP_WIDTH);
    const maxTop = Math.max(0, containerSize.height - MINIMAP_HEIGHT - MINIMAP_HEADER_HEIGHT);
    setPosition({
      left: Math.min(maxLeft, Math.max(0, event.clientX - rect.left - dragOffsetRef.current.x)),
      top: Math.min(maxTop, Math.max(0, event.clientY - rect.top - dragOffsetRef.current.y)),
    });
  };

  const stopPanelDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={panelRef}
      data-canvas-ui="minimap"
      className="pointer-events-auto absolute z-20 hidden overflow-hidden rounded-xl border border-border/70 bg-background/80 shadow-lg shadow-black/5 backdrop-blur-xl sm:block"
      style={{
        width: MINIMAP_WIDTH,
        ...(position ? { left: position.left, top: position.top } : { right: 12, bottom: 160 }),
      }}
      onPointerMove={handlePanelPointerMove}
      onPointerUp={stopPanelDragging}
      onPointerCancel={stopPanelDragging}
      onLostPointerCapture={() => {
        draggingRef.current = false;
      }}
    >
      <div
        className="flex cursor-grab touch-none items-center justify-between gap-1.5 border-b border-border/60 px-2 py-1 active:cursor-grabbing"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const panel = panelRef.current;
          const containerRect = panel?.parentElement?.getBoundingClientRect();
          if (!panel || !containerRect) {
            return;
          }
          const rect = panel.getBoundingClientRect();
          if (!position && containerRect) {
            setPosition({ left: rect.left - containerRect.left, top: rect.top - containerRect.top });
          }
          dragOffsetRef.current = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          };
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
      >
        <span className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
          <MapIcon className="size-3" strokeWidth={1.8} />
          {t("minimapTitle")}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">{nodes.length}</span>
      </div>
      <div
        ref={surfaceRef}
        className="relative cursor-pointer"
        style={{ height: MINIMAP_HEIGHT }}
        title={t("minimapHint")}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          draggingRef.current = true;
          dragTransformRef.current = { bounds, offsetX, offsetY, scale };
          event.currentTarget.setPointerCapture(event.pointerId);
          navigateFromEvent(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) {
            return;
          }
          event.stopPropagation();
          navigateFromEvent(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          dragTransformRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
          dragTransformRef.current = null;
        }}
        onLostPointerCapture={() => {
          draggingRef.current = false;
          dragTransformRef.current = null;
        }}
      >
        {/* 节点缩略：已完成节点直接绘制图片内容 */}
        {nodes.map((node) => {
          const rect = toMinimapRect(node.x, node.y, CANVAS_NODE_WIDTH, CANVAS_NODE_HEIGHT);
          const source = node.status === "done" ? node.objectURL : node.status === "streaming" ? node.previewURL : undefined;
          return (
            <div
              key={node.id}
              className={cn(
                "absolute overflow-hidden rounded-[2px] border",
                selectedSet.has(node.id)
                  ? "border-primary/80 ring-1 ring-primary/40"
                  : node.status === "error"
                    ? "border-destructive/50 bg-destructive/15"
                    : "border-border/60 bg-muted/70",
              )}
              style={rect}
            >
              {source ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" className="size-full object-cover" draggable={false} src={source} />
              ) : node.status === "error" ? (
                <span className="flex size-full items-center justify-center">
                  <AlertTriangle className="size-2.5 text-destructive/70" strokeWidth={2} />
                </span>
              ) : (
                <span className="block size-full animate-pulse bg-muted-foreground/20" />
              )}
            </div>
          );
        })}

        {/* 当前视口范围 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[3px] border border-primary/70 bg-primary/10"
          style={viewportRect}
        />
      </div>
    </div>
  );
}
