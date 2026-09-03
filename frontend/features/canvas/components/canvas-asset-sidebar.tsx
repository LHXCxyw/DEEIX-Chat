"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Clock3, Image as ImageIcon, Images, Loader2, PanelRightClose, PanelRightOpen, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  type CanvasNode,
} from "@/features/canvas/model/canvas-types";

const COLLAPSED_STORAGE_KEY = "deeix-canvas-assets-collapsed";

// 节点状态 -> 现有筛选文案键的静态映射（避免动态 i18n 键）
const STATUS_LABEL_KEYS = {
  pending: "filterPending",
  streaming: "filterStreaming",
  done: "filterDone",
  error: "filterError",
} as const;

type CanvasAssetSidebarProps = {
  nodes: CanvasNode[];
  selectedNodeIDs: string[];
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  onSelectNode: (nodeID: string) => void;
  onLocate: (point: { x: number; y: number }) => void;
};

// 画布资产列表侧边栏：展示全部节点（按生成时间倒序），点击行选中并定位到画布
export function CanvasAssetSidebar({ nodes, selectedNodeIDs, collapsed, onCollapsedChange, onSelectNode, onLocate }: CanvasAssetSidebarProps) {
  const t = useTranslations("canvas");
  const selectedSet = React.useMemo(() => new Set(selectedNodeIDs), [selectedNodeIDs]);

  const toggleCollapsed = React.useCallback(() => {
    onCollapsedChange(!collapsed);
  }, [collapsed, onCollapsedChange]);

  // 最新资产排在最前，index 保留生成顺序编号
  const orderedAssets = React.useMemo(
    () => nodes.map((node, index) => ({ node, index: index + 1 })).reverse(),
    [nodes],
  );

  if (collapsed) {
    return (
      <button
        type="button"
        data-canvas-ui="asset-sidebar-collapsed"
        aria-label={t("assetsExpand")}
        title={t("assetsExpand")}
        className="pointer-events-auto absolute right-3 top-20 z-30 flex size-11 flex-col items-center justify-center gap-0.5 rounded-2xl border border-border/70 bg-background/90 text-foreground shadow-lg backdrop-blur-2xl transition-colors hover:bg-accent"
        onClick={toggleCollapsed}
      >
        <PanelRightOpen className="size-4" />
        <span className="text-[9px] font-semibold tabular-nums text-muted-foreground">{nodes.length}</span>
      </button>
    );
  }

  return (
    <aside
      data-canvas-ui="asset-sidebar"
      className="pointer-events-auto absolute bottom-3 right-3 top-20 z-30 flex w-72 flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/90 shadow-xl backdrop-blur-2xl"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Images className="size-4 shrink-0 text-primary" strokeWidth={1.8} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("assetsPanel")}</h2>
        <span className="shrink-0 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">{nodes.length}</span>
        <button
          type="button"
          aria-label={t("assetsCollapse")}
          title={t("assetsCollapse")}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={toggleCollapsed}
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>
      {orderedAssets.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">{t("assetsEmpty")}</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {orderedAssets.map(({ node, index }) => {
            const selected = selectedSet.has(node.id);
            const label = node.status === "done" && node.fileName
              ? node.fileName
              : node.prompt.trim() || t("assetUntitled");
            const version = node.version ? `v${node.version}` : null;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  title={t("assetLocateHint")}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors",
                    selected ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-accent",
                  )}
                  onClick={() => {
                    onSelectNode(node.id);
                    onLocate({ x: node.x + CANVAS_NODE_WIDTH / 2, y: node.y + CANVAS_NODE_HEIGHT / 2 });
                  }}
                >
                  <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40">
                    {node.status === "done" && node.objectURL ? (
                      <img src={node.objectURL} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
                    ) : node.status === "done" ? (
                      <ImageIcon className="size-4 text-muted-foreground/70" strokeWidth={1.6} />
                    ) : node.status === "streaming" ? (
                      <Loader2 className="size-4 animate-spin text-primary" strokeWidth={1.8} />
                    ) : node.status === "pending" ? (
                      <Clock3 className="size-4 text-muted-foreground/70" strokeWidth={1.8} />
                    ) : (
                      <TriangleAlert className="size-4 text-destructive" strokeWidth={1.8} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="shrink-0 text-[9px] font-semibold tabular-nums text-muted-foreground/70">#{index}</span>
                      <span className="truncate text-xs font-medium">{label}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className={cn(node.status === "error" && "text-destructive")}>{t(STATUS_LABEL_KEYS[node.status])}</span>
                      {version ? <span className="rounded-sm bg-muted/60 px-1 font-semibold tabular-nums">{version}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
