"use client";

import { AudioLines, Image as ImageIcon, Video, X } from "lucide-react";
import * as React from "react";
import { CANVAS_NODE_REGISTRY } from "@/features/canvas/model/canvas-node-registry";
import type { CanvasMediaType, GraphNodeKind } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 资产名称条：常驻显示类型图标 + 名称，双击可改名；名称写回节点 reference.fileName
export function AssetNameBar({
  kind,
  name,
  onRename,
  className,
  editable = true,
}: {
  kind: "image" | "video" | "audio";
  name: string;
  onRename: (next: string) => void;
  className?: string;
  // 生成节点的名称来自模型 / 产物，不允许就地改名
  editable?: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!editing) {
      setDraft(name);
    }
  }, [editing, name]);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== name) {
      onRename(next);
    }
  };

  const Icon = kind === "video" ? Video : kind === "audio" ? AudioLines : ImageIcon;
  const tone = kind === "video" ? "text-violet-500" : kind === "audio" ? "text-fuchsia-500" : "text-sky-500";

  return (
    <div
      data-canvas-selectable
      title={name}
      className={cn("flex h-7 w-full min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground", className)}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={() => {
        if (!editable) {
          return;
        }
        setDraft(name);
        setEditing(true);
      }}
    >
      <Icon className={cn("size-3.5 shrink-0", tone)} strokeWidth={1.8} />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label={name}
          className="min-w-0 flex-1 rounded bg-background px-1 text-xs text-foreground outline-none ring-1 ring-primary/40"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{name}</span>
      )}
    </div>
  );
}

// 各类节点的主题色：用于标题栏点缀、端口与选中态的层次区分，从节点注册表派生
export const GRAPH_NODE_ACCENTS: Record<GraphNodeKind, { dot: string; soft: string; ring: string }> =
  Object.fromEntries(
    Object.values(CANVAS_NODE_REGISTRY).map((entry) => [entry.kind, entry.accent] as const),
  ) as Record<GraphNodeKind, { dot: string; soft: string; ring: string }>;

// 视频节点的紫色主题变体：与图像节点在同一画布上可一眼区分
export const VIDEO_NODE_ACCENT = { dot: "bg-violet-500", soft: "text-violet-500", ring: "ring-violet-500/40" };

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
  variant,
  bare = false,
  children,
}: {
  nodeID: string;
  kind: GraphNodeKind;
  // 媒体类型曾用于派生端口布局；单连接点交互后端口不再由节点渲染，保留字段兼容既有调用
  mediaType?: CanvasMediaType;
  title: string;
  icon: React.ReactNode;
  width: number;
  height: number;
  selected: boolean;
  compatible?: boolean;
  onRemove: () => void;
  removeLabel: string;
  // "video" 时使用视频主题色变体
  variant?: "video";
  // 无壳模式：不显示卡片背景、阴影、标题栏与描边，只保留内容（资产 / 生成节点）
  bare?: boolean;
  children: React.ReactNode;
}) {
  const accent = variant === "video" ? VIDEO_NODE_ACCENT : GRAPH_NODE_ACCENTS[kind];
  return (
    <div
      data-canvas-node-id={nodeID}
      className={cn(
        // 节点卡片不显示描边：层次由背景、阴影与选中光环表达
        "group/node relative flex flex-col overflow-visible select-none",
        bare
          ? "rounded-xl"
          : "rounded-2xl bg-card text-card-foreground shadow-[0_18px_50px_-32px_rgba(0,0,0,0.6)] transition-[box-shadow,filter] duration-200 hover:shadow-[0_22px_60px_-30px_rgba(0,0,0,0.55)]",
        selected && cn("ring-2", accent.ring),
        compatible && "ring-2 ring-primary/60",
      )}
      style={{ width, height }}
    >
      {/* 标题栏：左侧主题色点 + 图标 + 标题 + 悬停显示的删除按钮（无描边） */}
      {bare ? null : (
        <div className="flex h-8 shrink-0 items-center gap-2 px-2.5">
          <span className={cn("size-1.5 shrink-0 rounded-full", accent.dot)} aria-hidden="true" />
          {icon}
          <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/75">
            {title}
          </span>
          <button
            type="button"
            aria-label={removeLabel}
            title={removeLabel}
            data-canvas-selectable
            className="pointer-events-auto flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/node:opacity-100"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <X className="size-3.5" strokeWidth={1.8} />
          </button>
        </div>
      )}

      {/* 内容区 */}
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
