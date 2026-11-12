"use client";

import {
  AudioLines,
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
  Video,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { graphModelDisplayName } from "@/features/canvas/model/canvas-graph";
import {
  type GraphNode,
  type GraphNodeKind,
  graphNodeSize,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

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
  media: "bg-fuchsia-500",
  generate: "bg-amber-500",
  output: "bg-emerald-500",
  timeline: "bg-cyan-500",
};

type AssetGroupKey = "references" | "results" | "others";

type CanvasAssetSidebarProps = {
  nodes: GraphNode[];
  selectedNodeIDs: string[];
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  onSelectNode: (nodeID: string) => void;
  onLocate: (point: { x: number; y: number }) => void;
  // 视频/音频资产预览：直接播放产物，不跳转文件页
  onPreviewMedia: (node: GraphNode) => void;
};

// 资产行主标题：按节点类型取最有语义的文本
function assetTitle(node: GraphNode, untitled: string): string {
  switch (node.kind) {
    case "prompt":
      return node.text.trim() || untitled;
    case "image":
      return node.reference?.fileName || untitled;
    case "generate":
      return node.model ? graphModelDisplayName(node.model) : untitled;
    case "output":
      return (node.status === "done" && node.fileName) || node.prompt?.trim() || untitled;
    case "media":
      return node.reference?.fileName || untitled;
    case "timeline":
      return untitled;
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
    case "media":
      return null;
    case "timeline":
      return null;
  }
}

// 画布资产列表侧边栏：参考图片 / 生成结果 / 其他节点三组分类在顶部横向切换，
// 组内按创建时间倒序，点击行选中并定位到画布
export function CanvasAssetSidebar({ nodes, selectedNodeIDs, collapsed, onCollapsedChange, onSelectNode, onLocate, onPreviewMedia }: CanvasAssetSidebarProps) {
  const t = useTranslations("canvas");
  const selectedSet = React.useMemo(() => new Set(selectedNodeIDs), [selectedNodeIDs]);
  const [preferredGroup, setPreferredGroup] = React.useState<AssetGroupKey>("references");

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
    others: orderedAssets.filter(({ node }) => node.kind === "prompt" || node.kind === "generate" || node.kind === "media"),
  }), [orderedAssets]);

  // 资产行：缩略图 + 序号 + 标题 + 类型/状态副标题
  const renderAssetRow = React.useCallback(({ node, index }: { node: GraphNode; index: number }) => {
    const selected = selectedSet.has(node.id);
    const untitled = t("assetUntitled");
    const label = assetTitle(node, untitled);
    const size = graphNodeSize(node);
    const statusKey = assetStatusLabel(node);
    const outputVideo = node.kind === "output"
      && node.status === "done"
      && (node.mediaType === "video" || Boolean(node.mimeType?.startsWith("video/")));
    const mediaVideo = node.kind === "media" && node.mediaKind === "video";
    const isVideoAsset = outputVideo || mediaVideo;
    // 视频资产用 <video> 渲染首帧，图片仍用 <img>；二者不能混用同一 src
    const mediaSource = node.kind === "output"
      ? node.objectURL
      : node.kind === "media" ? node.previewURL : undefined;
    const thumbnail = node.kind === "image"
      ? node.previewURL
      : node.kind === "output" && node.status === "done" && !outputVideo
        ? node.objectURL
        : null;
    // 视频时长角标：读取真实元数据后由输出节点回写
    const durationLabel = node.kind === "output" && outputVideo && node.durationSeconds && node.durationSeconds > 0
      ? `${Math.round(node.durationSeconds)}s`
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
          : node.kind === "media"
            ? node.mediaKind === "video" ? t("nodeKindMediaVideo") : t("nodeKindMediaAudio")
            : t("nodeKindOutput");
    return (
      <li key={node.id} className="relative">
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
            {isVideoAsset && mediaSource ? (
              <video
                src={mediaSource}
                muted
                playsInline
                preload="metadata"
                className="absolute inset-0 size-full object-cover"
              />
            ) : thumbnail ? (
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
            ) : node.kind === "media" ? (
              node.mediaKind === "video"
                ? <Video className="size-4 text-muted-foreground/70" strokeWidth={1.6} />
                : <AudioLines className="size-4 text-muted-foreground/70" strokeWidth={1.6} />
            ) : node.kind === "image" && !node.reference ? (
              <ImageIcon className="size-4 text-muted-foreground/70" strokeWidth={1.6} />
            ) : (
              <Clock3 className="size-4 text-muted-foreground/70" strokeWidth={1.8} />
            )}
            {durationLabel ? (
              <span className="absolute bottom-0.5 right-0.5 rounded bg-background/85 px-1 text-[8px] font-semibold tabular-nums text-foreground/80">
                {durationLabel}
              </span>
            ) : null}
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
        {isVideoAsset ? (
          <button
            type="button"
            aria-label={t("assetPreviewVideo")}
            title={t("assetPreviewVideo")}
            className="absolute left-2.5 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border/60 backdrop-blur transition-colors hover:bg-background active:scale-95"
            onClick={(event) => {
              event.stopPropagation();
              onPreviewMedia(node);
            }}
          >
            <Play className="size-3 fill-current" strokeWidth={2} />
          </button>
        ) : null}
      </li>
    );
  }, [onLocate, onPreviewMedia, onSelectNode, selectedSet, t]);

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

  // 分类定义：参考图片与生成结果分开；空分类自动隐藏，当前分类为空时回退到首个非空分类
  const allGroupDefs: { key: AssetGroupKey; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; items: { node: GraphNode; index: number }[] }[] = [
    { key: "references", label: t("assetsGroupReferences"), icon: ImageIcon, items: groups.references },
    { key: "results", label: t("assetsGroupResults"), icon: Sparkles, items: groups.results },
    { key: "others", label: t("assetsGroupOthers"), icon: Shapes, items: groups.others },
  ];
  const groupDefs = allGroupDefs.filter((group) => group.items.length > 0);
  const activeGroup = groupDefs.find((group) => group.key === preferredGroup) ?? groupDefs[0];

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
        <>
          {/* 分类切换：顶部横向排列 */}
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
            {groupDefs.map((group) => {
              const GroupIcon = group.icon;
              const active = activeGroup?.key === group.key;
              return (
                <button
                  key={group.key}
                  type="button"
                  aria-pressed={active}
                  className={cn(
                    "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-[10px] font-medium transition-colors",
                    active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => setPreferredGroup(group.key)}
                >
                  <GroupIcon className="size-3 shrink-0" strokeWidth={2} />
                  <span className="truncate">{group.label}</span>
                  <span className="shrink-0 tabular-nums opacity-70">{group.items.length}</span>
                </button>
              );
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <ul className="space-y-1">
              {(activeGroup?.items ?? []).map(renderAssetRow)}
            </ul>
          </div>
        </>
      )}
    </aside>
  );
}
