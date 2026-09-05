"use client";

import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Image as ImageIcon,
  Images,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Shapes,
  Sparkles,
  TextCursorInput,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import {
  type GraphNode,
  type GraphNodeKind,
  graphNodeSize,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

const GROUPS_COLLAPSED_STORAGE_KEY = "deeix-canvas-asset-groups-collapsed";

// 节点状态 -> 现有筛选文案键的静态映射（避免动态 i18n 键）
const STATUS_LABEL_KEYS = {
  pending: "filterPending",
  streaming: "filterStreaming",
  done: "filterDone",
  error: "filterError",
} as const;

// 节点类型主题色（与节点外壳 accent 保持一致）
const KIND_ACCENTS: Record<GraphNodeKind, string> = {
  prompt: "bg-violet-500",
  image: "bg-sky-500",
  generate: "bg-amber-500",
  output: "bg-emerald-500",
};

type AssetGroupKey = "references" | "results" | "others";

type CanvasAssetSidebarProps = {
  nodes: GraphNode[];
  selectedNodeIDs: string[];
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  onSelectNode: (nodeID: string) => void;
  onLocate: (point: { x: number; y: number }) => void;
};

// 资产行主标题：按节点类型取最有语义的文本
function assetTitle(node: GraphNode, untitled: string): string {
  switch (node.kind) {
    case "prompt":
      return node.text.trim() || untitled;
    case "image":
      return node.reference?.fileName || untitled;
    case "generate":
      return node.model || untitled;
    case "output":
      return (node.status === "done" && node.fileName) || node.prompt?.trim() || untitled;
  }
}

// 资产行副标题：展示类型相关状态文案（与现有筛选文案键复用，返回 null 表示仅显示类型名）
function assetStatusLabel(node: GraphNode): keyof typeof STATUS_LABEL_KEYS | null {
  switch (node.kind) {
    case "prompt":
    case "image":
      return null;
    case "generate":
      return node.runStatus === "pending" ? "pending" : node.runStatus === "streaming" ? "streaming" : node.errorMessage ? "error" : null;
    case "output":
      return node.status === "error" ? "error" : node.status === "done" ? "done" : null;
  }
}

// 画布资产列表侧边栏：参考图片 / 生成结果 / 其他节点三组分组展示，
// 组内按创建时间倒序，分组可折叠（折叠状态本地持久化），点击行选中并定位到画布
export function CanvasAssetSidebar({ nodes, selectedNodeIDs, collapsed, onCollapsedChange, onSelectNode, onLocate }: CanvasAssetSidebarProps) {
  const t = useTranslations("canvas");
  const selectedSet = React.useMemo(() => new Set(selectedNodeIDs), [selectedNodeIDs]);
  // 分组折叠状态（SSR 安全：挂载后读取本地存储）
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<AssetGroupKey, boolean>>({
    references: false,
    results: false,
    others: false,
  });

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(GROUPS_COLLAPSED_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<AssetGroupKey, boolean>>;
        setCollapsedGroups({
          references: parsed.references === true,
          results: parsed.results === true,
          others: parsed.others === true,
        });
      }
    } catch {
      // 解析失败按默认展开处理
    }
  }, []);

  const toggleGroup = React.useCallback((key: AssetGroupKey) => {
    setCollapsedGroups((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        window.localStorage.setItem(GROUPS_COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 存储失败仅影响持久化，不影响交互
      }
      return next;
    });
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    onCollapsedChange(!collapsed);
  }, [collapsed, onCollapsedChange]);

  // 最新资产排在最前，index 保留创建顺序编号
  const orderedAssets = React.useMemo(
    () => nodes.map((node, index) => ({ node, index: index + 1 })).reverse(),
    [nodes],
  );

  // 参考图片 / 生成结果 / 其他节点三组分类，组内保持倒序
  const groups = React.useMemo(() => ({
    references: orderedAssets.filter(({ node }) => node.kind === "image"),
    results: orderedAssets.filter(({ node }) => node.kind === "output"),
    others: orderedAssets.filter(({ node }) => node.kind === "prompt" || node.kind === "generate"),
  }), [orderedAssets]);

  // 资产行：缩略图 + 序号 + 标题 + 类型/状态副标题
  const renderAssetRow = React.useCallback(({ node, index }: { node: GraphNode; index: number }) => {
    const selected = selectedSet.has(node.id);
    const untitled = t("assetUntitled");
    const label = assetTitle(node, untitled);
    const size = graphNodeSize(node);
    const statusKey = assetStatusLabel(node);
    const thumbnail = node.kind === "image"
      ? node.previewURL
      : node.kind === "output" && node.status === "done"
        ? node.objectURL
        : null;
    const uploading = node.kind === "image" && (node.uploading || (node.reference !== null && !node.previewURL && !node.previewFailed));
    const running = node.kind === "generate" && (node.runStatus === "pending" || node.runStatus === "streaming");
    const errored = (node.kind === "generate" && Boolean(node.errorMessage))
      || (node.kind === "output" && node.status === "error")
      || (node.kind === "image" && node.previewFailed);
    const kindLabel = node.kind === "prompt"
      ? t("nodeKindPrompt")
      : node.kind === "image"
        ? t("nodeKindImage")
        : node.kind === "generate"
          ? t("nodeKindGenerate")
          : t("nodeKindOutput");
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
            onLocate({ x: node.x + size.width / 2, y: node.y + size.height / 2 });
          }}
        >
          <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40">
            {thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbnail} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
            ) : running || uploading ? (
              <Loader2 className="size-4 animate-spin text-primary" strokeWidth={1.8} />
            ) : errored ? (
              <TriangleAlert className="size-4 text-destructive" strokeWidth={1.8} />
            ) : node.kind === "prompt" ? (
              <TextCursorInput className="size-4 text-muted-foreground/70" strokeWidth={1.6} />
            ) : node.kind === "generate" ? (
              <Play className="size-4 text-muted-foreground/70" strokeWidth={1.6} />
            ) : node.kind === "image" && !node.reference ? (
              <ImageIcon className="size-4 text-muted-foreground/70" strokeWidth={1.6} />
            ) : (
              <Clock3 className="size-4 text-muted-foreground/70" strokeWidth={1.8} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-[9px] font-semibold tabular-nums text-muted-foreground/70">#{index}</span>
              <span className="truncate text-xs font-medium">{label}</span>
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={cn("inline-flex items-center gap-1", errored && "text-destructive")}>
                <span className={cn("size-1.5 rounded-full", KIND_ACCENTS[node.kind])} aria-hidden="true" />
                {kindLabel}
              </span>
              {statusKey ? <span className={cn(statusKey === "error" && "text-destructive")}>{t(STATUS_LABEL_KEYS[statusKey])}</span> : null}
            </span>
          </span>
        </button>
      </li>
    );
  }, [onLocate, onSelectNode, selectedSet, t]);

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

  // 分组定义：参考图片与生成结果分开展示，空组自动隐藏
  const groupDefs: { key: AssetGroupKey; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; items: { node: GraphNode; index: number }[] }[] = [
    { key: "references", label: t("assetsGroupReferences"), icon: ImageIcon, items: groups.references },
    { key: "results", label: t("assetsGroupResults"), icon: Sparkles, items: groups.results },
    { key: "others", label: t("assetsGroupOthers"), icon: Shapes, items: groups.others },
  ];

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
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {groupDefs.map((group) => {
            if (group.items.length === 0) {
              return null;
            }
            const GroupIcon = group.icon;
            const isCollapsed = collapsedGroups[group.key];
            const Chevron = isCollapsed ? ChevronRight : ChevronDown;
            return (
              <section key={group.key} className="pb-1">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? t("assetsGroupExpand") : t("assetsGroupCollapse")}
                  className="mb-1 flex w-full items-center gap-1.5 rounded-md px-1 pt-1.5 pb-1 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70 transition-colors hover:bg-accent/60 hover:text-muted-foreground"
                  onClick={() => toggleGroup(group.key)}
                >
                  <Chevron className="size-3 shrink-0" strokeWidth={2} />
                  <GroupIcon className="size-3 shrink-0" strokeWidth={2} />
                  <span className="truncate">{group.label}</span>
                  <span className="ml-auto shrink-0 font-medium tabular-nums text-muted-foreground/50">{group.items.length}</span>
                </button>
                {isCollapsed ? null : (
                  <ul className="space-y-1">
                    {group.items.map(renderAssetRow)}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}
