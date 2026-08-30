"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Frame, Hand, Minus, Plus, Scan, SquareDashedMousePointer, Trash2 } from "lucide-react";

import { toast } from "sonner";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasPointerMode,
  type CanvasViewport,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

function ToolbarButton({
  label,
  onClick,
  disabled,
  destructive,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        destructive && "hover:text-destructive",
        // 当前指针模式高亮
        active && "bg-primary/12 text-primary shadow-sm ring-1 ring-primary/30 hover:bg-primary/15 hover:text-primary",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function CanvasToolbar({
  viewport,
  nodeCount,
  generatingCount,
  pointerMode,
  onPointerModeChange,
  onZoom,
  onReset,
  onFit,
  onClear,
}: {
  viewport: CanvasViewport;
  nodeCount: number;
  generatingCount: number;
  pointerMode: CanvasPointerMode;
  onPointerModeChange: (mode: CanvasPointerMode) => void;
  onZoom: (direction: "in" | "out") => void;
  onReset: () => void;
  onFit: () => void;
  onClear: () => void;
}) {
  const t = useTranslations("canvas");

  const handleClear = React.useCallback(() => {
    if (nodeCount === 0 && generatingCount === 0) {
      return;
    }
    toast(t("clearConfirmTitle"), {
      description: t("clearConfirmDescription"),
      action: {
        label: t("clearConfirmAction"),
        onClick: onClear,
      },
    });
  }, [generatingCount, nodeCount, onClear, t]);

  return (
    <div
      data-canvas-ui="toolbar"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3"
    >
      {/* 标题区 */}
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-border/70 bg-background/80 px-3 py-2 shadow-sm backdrop-blur-xl">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Frame className="size-4" strokeWidth={1.8} />
        </span>
        <div className="hidden flex-col leading-tight sm:flex">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            {t("title")}
          </span>
          <span className="text-[10px] text-muted-foreground/80">
            {generatingCount > 0
              ? t("generatingCount", { count: generatingCount })
              : t("nodeCount", { count: nodeCount })}
          </span>
        </div>
      </div>

      <div className="pointer-events-auto flex items-center gap-2">
        {/* 指针模式：拖动 / 框选 */}
        <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-background/80 px-1.5 py-1.5 shadow-sm backdrop-blur-xl">
          <ToolbarButton
            label={t("pointerModePan")}
            active={pointerMode === "pan"}
            onClick={() => onPointerModeChange("pan")}
          >
            <Hand className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
          <ToolbarButton
            label={t("pointerModeSelect")}
            active={pointerMode === "select"}
            onClick={() => onPointerModeChange("select")}
          >
            <SquareDashedMousePointer className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
        </div>

        {/* 缩放控制区 */}
        <div className="flex items-center gap-0.5 rounded-xl border border-border/70 bg-background/80 px-1.5 py-1.5 shadow-sm backdrop-blur-xl">
          <ToolbarButton label={t("zoomOut")} onClick={() => onZoom("out")} disabled={viewport.scale <= CANVAS_MIN_SCALE}>
            <Minus className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
          <button
            type="button"
            aria-label={t("resetView")}
            title={t("resetView")}
            className="min-w-12 rounded-md px-1 py-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onReset}
          >
            {Math.round(viewport.scale * 100)}%
          </button>
          <ToolbarButton label={t("zoomIn")} onClick={() => onZoom("in")} disabled={viewport.scale >= CANVAS_MAX_SCALE}>
            <Plus className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
          <div className="mx-0.5 h-4 w-px bg-border" />
          <ToolbarButton label={t("fitView")} onClick={onFit}>
            <Scan className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
          <ToolbarButton label={t("clearCanvas")} onClick={handleClear} destructive>
            <Trash2 className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
        </div>
      </div>
    </div>
  );
}
