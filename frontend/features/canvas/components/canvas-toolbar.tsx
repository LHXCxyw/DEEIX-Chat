"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AlignHorizontalDistributeCenter, Bookmark, BoxSelect, CircleHelp, Columns2, Download, FileDown, FileUp, Frame, GalleryVerticalEnd, Group, Hand, History, Layers, Lock, Menu, MessageSquareText, Minus, PanelTop, Plus, Redo2, Scan, SquareDashedMousePointer, Trash2, Undo2, Ungroup, X } from "lucide-react";

import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  elementCount,
  generatingCount,
  pointerMode,
  onPointerModeChange,
  onZoom,
  onReset,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  filter,
  onFilterChange,
  selectedCount,
  selectedResultCount,
  onCompare,
  onBatchExport,
  onAddFrame,
  onAddSection,
  onAddNote,
  onGroup,
  onUngroup,
  onLock,
  onAlign,
  onLayer,
  onBookmark,
  onProjectPanel,
  onExportProject,
  onImportProject,
  onTemplates,
  onHistory,
  onFit,
  onClear,
}: {
  viewport: CanvasViewport;
  nodeCount: number;
  elementCount: number;
  generatingCount: number;
  pointerMode: CanvasPointerMode;
  onPointerModeChange: (mode: CanvasPointerMode) => void;
  onZoom: (direction: "in" | "out") => void;
  onReset: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  filter: "all" | "pending" | "streaming" | "done" | "error";
  onFilterChange: (filter: "all" | "pending" | "streaming" | "done" | "error") => void;
  selectedCount: number;
  selectedResultCount: number;
  onCompare: () => void;
  onBatchExport: () => void;
  onAddFrame: () => void;
  onAddSection: () => void;
  onAddNote: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onLock: () => void;
  onAlign: () => void;
  onLayer: () => void;
  onBookmark: () => void;
  onProjectPanel: () => void;
  onExportProject: () => void;
  onImportProject: () => void;
  onTemplates: () => void;
  onHistory: () => void;
  onFit: () => void;
  onClear: () => void;
}) {
  const t = useTranslations("canvas");
  const [mobileToolsOpen, setMobileToolsOpen] = React.useState(false);
  const shortcuts: [string, string][] = [
    ["Space + Drag", t("shortcutPan")],
    ["V / H", t("shortcutModes")],
    ["Ctrl / Cmd + A", t("shortcutSelectAll")],
    ["Ctrl / Cmd + Z", t("shortcutUndo")],
    ["Delete", t("shortcutDelete")],
    ["Wheel / Pinch", t("shortcutZoom")],
  ];

  const handleClear = React.useCallback(() => {
    if (elementCount === 0 && generatingCount === 0) {
      return;
    }
    toast(t("clearConfirmTitle"), {
      description: t("clearConfirmDescription"),
      action: {
        label: t("clearConfirmAction"),
        onClick: onClear,
      },
    });
  }, [elementCount, generatingCount, onClear, t]);

  return (
    <div
      data-canvas-ui="toolbar"
      className="pointer-events-none absolute inset-0 z-10 flex items-start justify-between gap-3 p-3"
    >
      {/* 标题区同时作为项目列表入口 */}
      <button type="button" aria-label={t("projects")} title={t("projects")} onClick={onProjectPanel} className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-left shadow-sm backdrop-blur-xl transition-colors hover:border-primary/30 hover:bg-background/95">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Frame className="size-4" strokeWidth={1.8} />
        </span>
        <span className="hidden flex-col leading-tight sm:flex">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            {t("title")}
          </span>
          <span className={cn(
            "w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums",
            generatingCount > 0 ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-primary/12 text-primary",
          )}>
            {generatingCount > 0
              ? t("generatingCount", { count: generatingCount })
              : t("nodeCount", { count: nodeCount })}
          </span>
        </span>
      </button>

      <div className="pointer-events-auto flex min-w-0 max-w-[calc(100vw-4rem)] items-center gap-1 overflow-x-auto overscroll-x-contain sm:max-w-[calc(100vw-5rem)] sm:gap-2">
        <div className="hidden items-center gap-0.5 rounded-xl border border-border/70 bg-background/80 px-1.5 py-1.5 shadow-sm backdrop-blur-xl sm:flex">
          <ToolbarButton label={t("undo")} disabled={!canUndo} onClick={onUndo}>
            <Undo2 className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
          <ToolbarButton label={t("redo")} disabled={!canRedo} onClick={onRedo}>
            <Redo2 className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
        </div>
        <div className="hidden items-center gap-0.5 rounded-xl border border-border/70 bg-background/80 p-1.5 shadow-sm backdrop-blur-xl xl:flex">
          <ToolbarButton label={t("projects")} onClick={onProjectPanel}><GalleryVerticalEnd className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("addFrame")} onClick={onAddFrame}><Frame className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("addSection")} onClick={onAddSection}><PanelTop className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("addNote")} onClick={onAddNote}><MessageSquareText className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("group")} disabled={selectedCount < 2} onClick={onGroup}><Group className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("ungroup")} disabled={selectedCount === 0} onClick={onUngroup}><Ungroup className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("lock")} disabled={selectedCount === 0} onClick={onLock}><Lock className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("alignDistribute")} disabled={selectedCount < 2} onClick={onAlign}><AlignHorizontalDistributeCenter className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("layers")} disabled={selectedCount === 0} onClick={onLayer}><Layers className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("bookmark")} onClick={onBookmark}><Bookmark className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("templates")} onClick={onTemplates}><BoxSelect className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("history")} onClick={onHistory}><History className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("exportProject")} onClick={onExportProject}><FileDown className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("importProject")} onClick={onImportProject}><FileUp className="size-4" /></ToolbarButton>
        </div>
        <div className="hidden items-center gap-1 rounded-xl border border-border/70 bg-background/80 p-1.5 shadow-sm backdrop-blur-xl md:flex">
          <Select value={filter} onValueChange={(value) => onFilterChange(value as typeof filter)}>
            <SelectTrigger aria-label={t("statusFilter")} className="h-7 w-24 border-0 bg-transparent px-2 text-[11px] text-muted-foreground dark:bg-transparent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filterAll")}</SelectItem>
              <SelectItem value="done">{t("filterDone")}</SelectItem>
              <SelectItem value="pending">{t("filterPending")}</SelectItem>
              <SelectItem value="streaming">{t("filterStreaming")}</SelectItem>
              <SelectItem value="error">{t("filterError")}</SelectItem>
            </SelectContent>
          </Select>
          <ToolbarButton label={t("compareSelected")} disabled={selectedResultCount !== 2} onClick={onCompare}><Columns2 className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("batchExport")} disabled={selectedResultCount === 0} onClick={onBatchExport}><Download className="size-4" /></ToolbarButton>
        </div>
        <Popover open={mobileToolsOpen} onOpenChange={setMobileToolsOpen}>
          <div className="flex items-center rounded-xl border border-border/70 bg-background/80 p-1.5 shadow-sm backdrop-blur-xl xl:hidden">
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("mobileTools")}
                aria-expanded={mobileToolsOpen}
                title={t("mobileTools")}
                className={cn(
                  "flex size-9 touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:size-7",
                  mobileToolsOpen && "bg-primary/12 text-primary ring-1 ring-primary/30",
                )}
              >
                {mobileToolsOpen ? <X className="size-4" /> : <Menu className="size-4" />}
              </button>
            </PopoverTrigger>
          </div>
          <PopoverContent
            data-canvas-ui="mobile-tools"
            align="end"
            side="bottom"
            sideOffset={8}
            className="grid max-h-[min(28rem,var(--radix-popover-content-available-height))] w-56 gap-1 overflow-y-auto overscroll-contain rounded-2xl border-border/70 bg-background/95 p-2 shadow-xl backdrop-blur-2xl sm:w-64"
          >
            <Select value={filter} onValueChange={(value) => onFilterChange(value as typeof filter)}>
              <SelectTrigger aria-label={t("statusFilter")} className="mb-1 h-10 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filterAll")}</SelectItem>
                <SelectItem value="done">{t("filterDone")}</SelectItem>
                <SelectItem value="pending">{t("filterPending")}</SelectItem>
                <SelectItem value="streaming">{t("filterStreaming")}</SelectItem>
                <SelectItem value="error">{t("filterError")}</SelectItem>
              </SelectContent>
            </Select>
            {([
              [t("undo"), onUndo, Undo2, !canUndo], [t("redo"), onRedo, Redo2, !canRedo],
              [t("compareSelected"), onCompare, Columns2, selectedResultCount !== 2], [t("batchExport"), onBatchExport, Download, selectedResultCount === 0],
              [t("projects"), onProjectPanel, GalleryVerticalEnd, false], [t("addFrame"), onAddFrame, Frame, false], [t("addSection"), onAddSection, PanelTop, false], [t("addNote"), onAddNote, MessageSquareText, false],
              [t("group"), onGroup, Group, selectedCount < 2], [t("ungroup"), onUngroup, Ungroup, selectedCount === 0], [t("lock"), onLock, Lock, selectedCount === 0], [t("alignDistribute"), onAlign, AlignHorizontalDistributeCenter, selectedCount < 2], [t("layers"), onLayer, Layers, selectedCount === 0],
              [t("bookmark"), onBookmark, Bookmark, false], [t("templates"), onTemplates, BoxSelect, false], [t("history"), onHistory, History, false], [t("exportProject"), onExportProject, FileDown, false], [t("importProject"), onImportProject, FileUp, false],
            ] satisfies Array<[string, () => void, React.ComponentType<{ className?: string }>, boolean]>).map(([label, action, Icon, disabled]) => (
              <button key={label} type="button" disabled={disabled} className="flex min-h-10 touch-manipulation items-center gap-2 rounded-xl px-3 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40" onClick={() => { action(); setMobileToolsOpen(false); }}>
                <Icon className="size-4 text-muted-foreground" />{label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
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

        <aside
          data-canvas-ui="shortcut-help"
          aria-label={t("shortcutHelp")}
          className="pointer-events-none absolute bottom-28 left-3 hidden w-56 rounded-xl border border-border/40 bg-background/45 px-3 py-2.5 opacity-75 shadow-sm backdrop-blur-md sm:block"
        >
          <div className="mb-2 flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
            <CircleHelp className="size-3.5 shrink-0 text-primary/80" />
            {t("shortcutHelp")}
          </div>
          <div className="grid gap-1.5">
            {shortcuts.map(([keys, label]) => (
              <span key={keys} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80">
                <span className="truncate">{label}</span>
                <kbd className="shrink-0 rounded border border-border/50 bg-background/50 px-1.5 py-0.5 font-mono text-[9px] text-foreground/70">{keys}</kbd>
              </span>
            ))}
          </div>
        </aside>
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
