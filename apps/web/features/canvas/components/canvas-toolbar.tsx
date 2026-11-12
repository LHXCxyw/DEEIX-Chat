"use client";

import {
  Bookmark,
  FileDown,
  FileUp,
  Frame,
  GalleryVerticalEnd,
  Hand,
  History,
  Lock,
  Menu,
  MessageSquareText,
  Minus,
  Plus,
  Redo2,
  Scan,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  X
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CanvasSettingsMenu } from "@/features/canvas/components/canvas-settings-menu";
import type { CanvasModelOption } from "@/features/canvas/model/canvas-image-options";
import { CANVAS_TOOLBAR_ACTIONS } from "@/features/canvas/model/canvas-node-registry";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasNodeMediaHint,
  type CanvasPointerMode,
  type CanvasViewport,
  type GraphNodeKind,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

function ToolbarButton({
  label,
  description,
  onClick,
  disabled,
  destructive,
  active,
  children,
}: {
  label: string;
  // 按钮旁展示的短文本描述（桌面端工具栏）
  description?: string;
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
        description && "w-auto gap-1.5 px-2",
        destructive && "hover:text-destructive",
        // 当前指针模式高亮
        active && "bg-primary/10 text-primary shadow-sm ring-1 ring-primary/30 hover:bg-primary/15 hover:text-primary",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
      onClick={onClick}
    >
      {children}
      {description ? <span className="text-[11px] font-medium whitespace-nowrap">{description}</span> : null}
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  selectedCount,
  onAddNode,
  onAddFrame,
  onAddNote,
  onLock,
  onBookmark,
  onProjectPanel,
  onExportProject,
  onImportProject,
  onHistory,
  onFit,
  onClear,
  textModels,
}: {
  viewport: CanvasViewport;
  nodeCount: number;
  generatingCount: number;
  pointerMode: CanvasPointerMode;
  onPointerModeChange: (mode: CanvasPointerMode) => void;
  onZoom: (direction: "in" | "out") => void;
  onReset: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selectedCount: number;
  onAddNode: (kind: GraphNodeKind, mediaType?: CanvasNodeMediaHint) => void;
  onAddFrame: () => void;
  onAddNote: () => void;
  onLock: () => void;
  onBookmark: () => void;
  onProjectPanel: () => void;
  onExportProject: () => void;
  onImportProject: () => void;
  onHistory: () => void;
  onFit: () => void;
  onClear: () => void;
  // 提示词优化可选的文本模型
  textModels: CanvasModelOption[];
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

  // 节点添加按钮：从节点注册表派生（含生成节点的图像 / 视频两条入口），保持登记顺序
  const nodeActions = CANVAS_TOOLBAR_ACTIONS;

  const renderNodeActions = (size: "sm" | "full") =>
    nodeActions.map(({ kind, mediaType, labelKey, descriptionKey, icon: Icon }) => {
      const actionKey = `${kind}-${mediaType ?? "default"}`;
      const label = t(labelKey);
      const description = t(descriptionKey);
      return size === "sm" ? (
        <ToolbarButton key={actionKey} label={label} description={description} onClick={() => onAddNode(kind, mediaType)}>
          <Icon className="size-4" />
        </ToolbarButton>
      ) : (
        <button
          key={actionKey}
          type="button"
          className="flex min-h-10 touch-manipulation items-center gap-2 rounded-xl px-3 text-left text-xs text-foreground transition-colors hover:bg-accent"
          onClick={() => {
            onAddNode(kind, mediaType);
            setMobileToolsOpen(false);
          }}
        >
          <Icon className="size-4 text-muted-foreground" />
          {label}
        </button>
      );
    });

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
            generatingCount > 0 ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-primary/10 text-primary",
          )}>
            {generatingCount > 0
              ? t("generatingCount", { count: generatingCount })
              : t("nodeCount", { count: nodeCount })}
          </span>
        </span>
      </button>

      <div className="pointer-events-auto flex min-w-0 max-w-[calc(100vw-4rem)] items-center gap-1 overflow-x-auto overscroll-x-contain sm:max-w-[calc(100vw-5rem)] sm:gap-2">
        {/* 节点添加组 */}
        <div className="hidden items-center gap-0.5 rounded-xl border border-border/70 bg-background/80 px-1.5 py-1.5 shadow-sm backdrop-blur-xl lg:flex">
          {renderNodeActions("sm")}
        </div>
        <div className="hidden items-center gap-0.5 rounded-xl border border-border/70 bg-background/80 p-1.5 shadow-sm backdrop-blur-xl xl:flex">
          <ToolbarButton label={t("undo")} onClick={onUndo} disabled={!canUndo}><Undo2 className="size-4" strokeWidth={1.8} /></ToolbarButton>
          <ToolbarButton label={t("redo")} onClick={onRedo} disabled={!canRedo}><Redo2 className="size-4" strokeWidth={1.8} /></ToolbarButton>
          <div className="mx-0.5 h-4 w-px bg-border" />
          <ToolbarButton label={t("projects")} description={t("toolbarProjects")} onClick={onProjectPanel}><GalleryVerticalEnd className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("addFrame")} description={t("toolbarFrame")} onClick={onAddFrame}><Frame className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("addNote")} description={t("toolbarNote")} onClick={onAddNote}><MessageSquareText className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("lock")} description={t("toolbarLock")} disabled={selectedCount === 0} onClick={onLock}><Lock className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("bookmark")} description={t("toolbarBookmark")} onClick={onBookmark}><Bookmark className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("history")} description={t("toolbarHistory")} onClick={onHistory}><History className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("exportProject")} description={t("toolbarExport")} onClick={onExportProject}><FileDown className="size-4" /></ToolbarButton>
          <ToolbarButton label={t("importProject")} description={t("toolbarImport")} onClick={onImportProject}><FileUp className="size-4" /></ToolbarButton>
        </div>
        {/* 右上角菜单：提示词优化配置与快捷键面板 */}
        <div className="flex shrink-0 items-center rounded-xl border border-border/70 bg-background/80 p-1 shadow-sm backdrop-blur-xl">
          <CanvasSettingsMenu shortcuts={shortcuts} textModels={textModels} />
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
                  mobileToolsOpen && "bg-primary/10 text-primary ring-1 ring-primary/30",
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
            {renderNodeActions("full")}
            <div className="my-1 h-px bg-border" />
            {([
              [t("undo"), onUndo, Undo2, !canUndo], [t("redo"), onRedo, Redo2, !canRedo],
              [t("projects"), onProjectPanel, GalleryVerticalEnd, false], [t("addFrame"), onAddFrame, Frame, false], [t("addNote"), onAddNote, MessageSquareText, false],
              [t("lock"), onLock, Lock, selectedCount === 0],
              [t("bookmark"), onBookmark, Bookmark, false], [t("history"), onHistory, History, false], [t("exportProject"), onExportProject, FileDown, false], [t("importProject"), onImportProject, FileUp, false],
            ] satisfies Array<[string, () => void, React.ComponentType<{ className?: string }>, boolean]>).map(([label, action, Icon, disabled]) => (
              <button key={label} type="button" disabled={disabled} className="flex min-h-10 touch-manipulation items-center gap-2 rounded-xl px-3 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40" onClick={() => { action(); setMobileToolsOpen(false); }}>
                <Icon className="size-4 text-muted-foreground" />{label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        {/* 左下角悬浮工具条：指针模式 / 新建组 / 缩放（桌面端） */}
        <div className="pointer-events-auto absolute bottom-3 left-3 z-10 hidden max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-xl border border-border/60 bg-background/80 px-1.5 py-1.5 shadow-lg backdrop-blur-xl lg:flex">
          <ToolbarButton
            label={pointerMode === "pan" ? t("pointerModeSelect") : t("pointerModePan")}
            onClick={() => onPointerModeChange(pointerMode === "pan" ? "select" : "pan")}
          >
            {pointerMode === "pan"
              ? <Hand className="size-4" strokeWidth={1.8} />
              : <SquareDashedMousePointer className="size-4" strokeWidth={1.8} />}
          </ToolbarButton>
          <div className="mx-0.5 h-4 w-px bg-border" />
          <ToolbarButton label={t("addFrame")} onClick={onAddFrame}>
            <Frame className="size-4" strokeWidth={1.8} />
          </ToolbarButton>
          <div className="mx-0.5 h-4 w-px bg-border" />
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
