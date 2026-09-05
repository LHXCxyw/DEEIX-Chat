"use client";

import { X } from "lucide-react";
import * as React from "react";
import { type GraphPortDefinition, graphNodePorts } from "@/features/canvas/model/canvas-graph";
import type { GraphNodeKind } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 各类节点的主题色：用于标题栏点缀、端口与选中态的层次区分
export const GRAPH_NODE_ACCENTS: Record<GraphNodeKind, { dot: string; soft: string; ring: string }> = {
  prompt: { dot: "bg-violet-500", soft: "text-violet-500", ring: "ring-violet-500/40" },
  image: { dot: "bg-sky-500", soft: "text-sky-500", ring: "ring-sky-500/40" },
  generate: { dot: "bg-amber-500", soft: "text-amber-500", ring: "ring-amber-500/40" },
  output: { dot: "bg-emerald-500", soft: "text-emerald-500", ring: "ring-emerald-500/40" },
};

// 节点端口：出入方向决定左右位置，纵向偏移按端口定义固定
function GraphPort({
  nodeID,
  port,
  accent,
  highlighted,
}: {
  nodeID: string;
  port: GraphPortDefinition;
  accent: string;
  highlighted: boolean;
}) {
  const isOut = port.direction === "out";
  return (
    <span
      data-graph-port={port.direction}
      data-graph-port-id={port.id}
      data-graph-node-id={nodeID}
      aria-hidden="true"
      className={cn(
        "group/port absolute z-20 flex size-4 cursor-crosshair items-center justify-center",
        isOut ? "-right-2 -translate-x-0" : "-left-2",
      )}
      style={{ top: port.offsetY - 8 }}
    >
      {/* 命中区扩大便于拖拽，视觉圆点居中 */}
      <span
        className={cn(
          "block size-2.5 rounded-full border-2 transition-all duration-150 group-hover/port:scale-125",
          isOut
            ? cn("border-transparent", accent, "shadow-[0_0_0_3px_color-mix(in_oklab,var(--background)_85%,transparent)]")
            : "border-muted-foreground/50 bg-background",
          highlighted && "scale-125 ring-2 ring-primary/60",
        )}
      />
    </span>
  );
}

// 图节点外壳：标题栏（图标 + 标题 + 删除）、内容区与端口；尺寸固定以保证端口几何正确
export function GraphNodeShell({
  nodeID,
  kind,
  title,
  icon,
  width,
  height,
  selected,
  compatible,
  onRemove,
  removeLabel,
  children,
}: {
  nodeID: string;
  kind: GraphNodeKind;
  title: string;
  icon: React.ReactNode;
  width: number;
  height: number;
  selected: boolean;
  compatible?: boolean;
  onRemove: () => void;
  removeLabel: string;
  children: React.ReactNode;
}) {
  const accent = GRAPH_NODE_ACCENTS[kind];
  const ports = graphNodePorts(kind);
  return (
    <div
      className={cn(
        "group/node relative flex flex-col overflow-visible rounded-2xl border bg-card text-card-foreground select-none",
        "border-border/70 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.55)] transition-[border-color,box-shadow] duration-200",
        "hover:border-primary/35",
        selected && cn("border-primary/60 ring-2", accent.ring),
        compatible && "border-primary/70",
      )}
      style={{ width, height }}
    >
      {/* 标题栏：左侧主题色点 + 图标 + 大写标题 + 删除按钮 */}
      <div className="flex h-9 shrink-0 items-center gap-2 rounded-t-2xl border-b border-border/60 bg-muted/30 px-3">
        <span className={cn("size-1.5 shrink-0 rounded-full", accent.dot)} aria-hidden="true" />
        {icon}
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/80">
          {title}
        </span>
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          data-canvas-selectable
          className="pointer-events-auto flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>

      {/* 内容区 */}
      <div className="relative min-h-0 flex-1">{children}</div>

      {/* 端口：固定几何位置，由视口统一处理连线交互 */}
      {ports.map((port) => (
        <GraphPort key={port.id} nodeID={nodeID} port={port} accent={accent.dot} highlighted={compatible === true} />
      ))}
    </div>
  );
}
