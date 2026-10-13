"use client";

import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  canvasModelKey,
  modelSupportsImageEditRoute,
  modelSupportsVideoRoute,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import { cn } from "@/lib/utils";
import {
  ModelIcon,
  resolveModelIconURL,
  resolveModelIdentity,
  resolveModelPresentationGroup,
} from "@/entities/model";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import {
  resolveDesktopMenuListMaxHeight,
  resolveDesktopModelMenuListMaxHeight,
} from "@/features/chat";

// 与对话模型选择器（ChatModelPicker）同构：用户模型按接口（上游渠道）分节、节内按提供商
// 分类；平台模型按展示分组。分组面板与模型列表面板相互独立（二级面板绝对定位），
// hover 切换分组时互不影响高度。不同接口下的重名模型全部保留，按所属接口区分。
type CanvasModelGroup = {
  key: string;
  label: string;
  icon: string;
  channelKey?: string;
  channelLabel?: string;
  items: CanvasModelOption[];
};

function resolveCanvasModelGroups(models: ReadonlyArray<CanvasModelOption>): CanvasModelGroup[] {
  const groupMap = new Map<
    string,
    {
      label: string;
      icon: string;
      channelKey?: string;
      channelLabel?: string;
      items: CanvasModelOption[];
    }
  >();
  const channelOrder = new Map<string, number>();
  for (const item of models) {
    const isUserModel = item.modelScope === "user";
    const providerKey = item.vendor || item.vendorName || "unknown";
    const channelKey = isUserModel
      ? String(item.upstreamID ?? item.upstreamName ?? "unknown")
      : undefined;
    if (channelKey && !channelOrder.has(channelKey)) {
      channelOrder.set(channelKey, channelOrder.size);
    }
    const key = isUserModel
      ? `user:${channelKey}:${providerKey}`
      : resolveModelPresentationGroup(item).key;
    const presentation = isUserModel
      ? { label: item.vendorName || item.vendor || "其他提供商", icon: item.vendorIcon }
      : resolveModelPresentationGroup(item);
    const group = groupMap.get(key);
    if (group) {
      group.items.push(item);
      continue;
    }
    groupMap.set(key, {
      label: presentation.label,
      icon: presentation.icon,
      channelKey,
      channelLabel: isUserModel ? item.upstreamName || "用户渠道" : undefined,
      items: [item],
    });
  }

  return Array.from(groupMap.entries())
    .map(([key, group]) => ({ key, ...group }))
    .sort((left, right) => {
      if (!left.channelKey || !right.channelKey) {
        return 0;
      }
      return (channelOrder.get(left.channelKey) ?? 0) - (channelOrder.get(right.channelKey) ?? 0);
    });
}

const MODEL_MENU_COLLISION_PADDING = 24;
const DESKTOP_MODEL_MENU_WIDTH = 224;
const DESKTOP_MODEL_SUBMENU_GAP = 8;
const DESKTOP_MODEL_MENU_SIDE_OFFSET = 8;
const DESKTOP_MODEL_MENU_MIN_SCROLL_HEIGHT = 96;
/** Group panel non-list chrome: p-1.5 × 2 + header h-7. */
const DESKTOP_GROUP_MENU_VERTICAL_CHROME = 40;
/** Model submenu non-list chrome: p-1.5 × 2. */
const DESKTOP_SUBMENU_VERTICAL_CHROME = 12;

function CanvasModelCapabilityBadge({ model }: { model: CanvasModelOption }) {
  const t = useTranslations("canvas");
  if (modelSupportsVideoRoute(model)) {
    return (
      <span className="shrink-0 rounded-sm bg-violet-500/10 px-1 py-px text-[9px] font-semibold text-violet-600 dark:text-violet-300">
        {t("modelVideoCapable")}
      </span>
    );
  }
  if (modelSupportsImageEditRoute(model)) {
    return (
      <span className="shrink-0 rounded-sm bg-primary/10 px-1 py-px text-[9px] font-semibold text-primary">
        {t("modelEditCapable")}
      </span>
    );
  }
  return null;
}

function CanvasModelMenuItem({
  model,
  selected,
  onSelect,
  buttonRef,
}: {
  model: CanvasModelOption;
  selected: boolean;
  onSelect: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const platformModelName = model.platformModelName.trim();
  const identity = React.useMemo(
    () =>
      resolveModelIdentity({
        code: model.platformModelName,
        vendor: model.vendor,
        icon: model.icon,
      }),
    [model.icon, model.platformModelName, model.vendor],
  );
  const iconURL = React.useMemo(() => resolveModelIconURL(identity.modelIcon), [identity.modelIcon]);

  // 与对话模型选择器的列表项一致：图标 + 完整模型名（不截断）+ 勾选；
  // 能力徽标只出现在触发按钮上，避免挤占名称宽度导致截断
  return (
    <div
      data-selected={selected}
      className="group flex h-7 items-center rounded-md text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      <button
        ref={buttonRef}
        type="button"
        className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-transparent py-0 pl-2 pr-1 text-left text-[11px] font-medium leading-none text-inherit outline-none"
        onClick={onSelect}
      >
        <ModelIcon iconUrl={iconURL} label={platformModelName} />
        <span className="min-w-0 flex-1 whitespace-nowrap leading-4" title={platformModelName}>
          {platformModelName}
        </span>
        <span className="flex size-3 shrink-0 items-center justify-center">
          {selected ? <Check className="size-3 text-current" strokeWidth={1.7} /> : null}
        </span>
      </button>
    </div>
  );
}

// 滚动容器：上下渐隐提示（与对话模型选择器一致）
function ModelMenuScrollContainer({
  children,
  maxHeight,
  onScroll,
}: {
  children: React.ReactNode;
  maxHeight?: number;
  onScroll?: () => void;
}) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [hasMoreAbove, setHasMoreAbove] = React.useState(false);
  const [hasMoreBelow, setHasMoreBelow] = React.useState(false);
  const resolvedMaxHeight = Number.isFinite(maxHeight) ? Math.max(0, maxHeight ?? 0) : undefined;

  const updateScrollHints = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      setHasMoreAbove(false);
      setHasMoreBelow(false);
      return;
    }
    const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    setHasMoreAbove(viewport.scrollTop > 1);
    setHasMoreBelow(remaining > 1);
  }, []);

  React.useLayoutEffect(() => {
    updateScrollHints();
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateScrollHints);
    observer.observe(viewport);
    if (viewport.firstElementChild) {
      observer.observe(viewport.firstElementChild);
    }
    return () => observer.disconnect();
  }, [children, resolvedMaxHeight, updateScrollHints]);

  const handleScroll = React.useCallback(() => {
    updateScrollHints();
    onScroll?.();
  }, [onScroll, updateScrollHints]);

  return (
    <div className="relative">
      <div
        ref={viewportRef}
        style={resolvedMaxHeight === undefined ? undefined : { maxHeight: resolvedMaxHeight }}
        className={cn(
          "overflow-y-auto overscroll-contain pr-0 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          resolvedMaxHeight === undefined
            ? "max-h-[min(20rem,var(--model-menu-scroll-max-height,var(--radix-popover-content-available-height)))]"
            : null,
        )}
        onScroll={handleScroll}
      >
        {children}
      </div>
      {hasMoreAbove ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-4 items-start justify-center rounded-t-lg bg-gradient-to-b from-popover via-popover/80 to-transparent pt-px">
          <ChevronDown className="size-3 rotate-180 text-muted-foreground/75" strokeWidth={1.8} />
        </div>
      ) : null}
      {hasMoreBelow ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-4 items-end justify-center rounded-b-lg bg-gradient-to-t from-popover via-popover/80 to-transparent pb-px">
          <ChevronDown className="size-3 text-muted-foreground/75" strokeWidth={1.8} />
        </div>
      ) : null}
    </div>
  );
}

export function CanvasModelSelect({
  models,
  selectedModel,
  onSelect,
  onOpenChange,
  disabled,
  align = "start",
  side = "top",
  className,
}: {
  models: CanvasModelOption[];
  selectedModel: CanvasModelOption | null;
  // 以模型条目回调（携带作用域与用户模型 ID），同名模型可区分来源接口
  onSelect: (model: CanvasModelOption) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
}) {
  const t = useTranslations("canvas");
  const isMobile = useIsMobile();
  const [open, setOpen] = React.useState(false);
  const [activeGroupKey, setActiveGroupKey] = React.useState("");
  const [mobileGroupKey, setMobileGroupKey] = React.useState<string | null>(null);
  const [scopeTab, setScopeTab] = React.useState<"platform" | "user">("platform");
  const [collapsedChannelKeys, setCollapsedChannelKeys] = React.useState<Set<string>>(new Set());
  const [desktopSubmenuSide, setDesktopSubmenuSide] = React.useState<"right" | "left">("right");
  const [desktopSubmenuTop, setDesktopSubmenuTop] = React.useState(0);
  const [desktopSubmenuWidth, setDesktopSubmenuWidth] = React.useState(DESKTOP_MODEL_MENU_WIDTH);
  const [desktopGroupListMaxHeight, setDesktopGroupListMaxHeight] = React.useState(320);
  const [desktopSubmenuListMaxHeight, setDesktopSubmenuListMaxHeight] = React.useState(320);
  const desktopMenuRootRef = React.useRef<HTMLDivElement | null>(null);
  const desktopGroupMenuRef = React.useRef<HTMLDivElement | null>(null);
  const desktopSubmenuRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const selectedModelButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const desktopGroupItemRefs = React.useRef(new Map<string, HTMLButtonElement>());

  const selectedKey = selectedModel ? canvasModelKey(selectedModel) : "";
  const allModelGroups = React.useMemo(() => resolveCanvasModelGroups(models), [models]);
  const modelGroups = React.useMemo(
    () => allModelGroups.filter((group) => group.items.some((item) => (item.modelScope ?? "platform") === scopeTab)),
    [allModelGroups, scopeTab],
  );
  const selectedGroupKey = React.useMemo(() => {
    if (!selectedModel) {
      return "";
    }
    return selectedModel.modelScope === "user"
      ? `user:${String(selectedModel.upstreamID ?? selectedModel.upstreamName ?? "unknown")}:${selectedModel.vendor || selectedModel.vendorName || "unknown"}`
      : resolveModelPresentationGroup(selectedModel).key;
  }, [selectedModel]);
  const selectedGroupLabel = React.useMemo(() => {
    if (!selectedModel) {
      return "none";
    }
    return selectedModel.modelScope === "user"
      ? selectedModel.upstreamName || "用户渠道"
      : resolveModelPresentationGroup(selectedModel).label;
  }, [selectedModel]);
  const activeDesktopGroupKey = activeGroupKey || selectedGroupKey || modelGroups[0]?.key || "";
  const activeDesktopGroup = React.useMemo(
    () => modelGroups.find((group) => group.key === activeDesktopGroupKey) ?? modelGroups[0] ?? null,
    [activeDesktopGroupKey, modelGroups],
  );
  const hasDesktopModelSubmenu = Boolean(activeDesktopGroup?.items.length);
  const mobileGroup = React.useMemo(
    () => modelGroups.find((group) => group.key === mobileGroupKey) ?? null,
    [mobileGroupKey, modelGroups],
  );
  const activeModels = activeDesktopGroup?.items ?? [];

  React.useEffect(() => {
    if (!open || !isMobile) {
      setMobileGroupKey(null);
    }
  }, [isMobile, open]);

  const updateDesktopSubmenuMetrics = React.useCallback(() => {
    if (!open || isMobile) {
      setDesktopSubmenuSide("right");
      setDesktopSubmenuTop(0);
      setDesktopSubmenuWidth(DESKTOP_MODEL_MENU_WIDTH);
      setDesktopGroupListMaxHeight(320);
      setDesktopSubmenuListMaxHeight(320);
      return;
    }

    const menuRoot = desktopMenuRootRef.current;
    const groupMenu = desktopGroupMenuRef.current;
    if (!menuRoot || !groupMenu) {
      return;
    }

    const menuRootRect = menuRoot.getBoundingClientRect();
    const groupMenuRect = groupMenu.getBoundingClientRect();
    const submenu = desktopSubmenuRef.current;
    const submenuRect = submenu?.getBoundingClientRect();
    const activeGroupButton = activeDesktopGroup
      ? desktopGroupItemRefs.current.get(activeDesktopGroup.key)
      : null;
    const activeGroupRect = activeGroupButton?.getBoundingClientRect();
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const viewportLeft = MODEL_MENU_COLLISION_PADDING;
    const viewportRight = window.innerWidth - MODEL_MENU_COLLISION_PADDING;
    const viewportTop = MODEL_MENU_COLLISION_PADDING;
    const viewportBottom = window.innerHeight - MODEL_MENU_COLLISION_PADDING;
    const viewportHeight = Math.max(0, viewportBottom - viewportTop);
    const rightAvailableWidth = Math.max(0, viewportRight - groupMenuRect.right - DESKTOP_MODEL_SUBMENU_GAP);
    const leftAvailableWidth = Math.max(0, groupMenuRect.left - viewportLeft - DESKTOP_MODEL_SUBMENU_GAP);
    const nextSubmenuSide =
      rightAvailableWidth >= DESKTOP_MODEL_MENU_WIDTH || rightAvailableWidth >= leftAvailableWidth
        ? "right"
        : "left";
    const nextSubmenuWidth = Math.max(
      DESKTOP_MODEL_MENU_MIN_SCROLL_HEIGHT,
      Math.min(
        DESKTOP_MODEL_MENU_WIDTH,
        nextSubmenuSide === "right" ? rightAvailableWidth : leftAvailableWidth,
      ),
    );
    const nextGroupListMaxHeight = resolveDesktopModelMenuListMaxHeight({
      viewportTop,
      viewportBottom,
      triggerTop: triggerRect?.top,
      triggerBottom: triggerRect?.bottom,
      sideOffset: DESKTOP_MODEL_MENU_SIDE_OFFSET,
      verticalChrome: DESKTOP_GROUP_MENU_VERTICAL_CHROME,
    });

    let nextSubmenuTop = 0;
    let nextSubmenuListMaxHeight = nextGroupListMaxHeight;
    if (hasDesktopModelSubmenu && activeGroupRect) {
      const submenuHeight = submenuRect?.height ?? nextGroupListMaxHeight + DESKTOP_SUBMENU_VERTICAL_CHROME;
      const submenuOuterHeight = Math.min(submenuHeight, viewportHeight);
      const maxViewportTop = Math.max(viewportTop, viewportBottom - submenuOuterHeight);
      // Anchor in viewport coordinates, then convert to an offset within
      // menuRoot (which may sit above viewportTop for a frame before re-shift).
      const preferredSubmenuViewportTop = Math.min(
        Math.max(activeGroupRect.top, viewportTop),
        maxViewportTop,
      );
      nextSubmenuTop = preferredSubmenuViewportTop - menuRootRect.top;
      const actualSubmenuViewportTop = menuRootRect.top + nextSubmenuTop;
      nextSubmenuListMaxHeight = resolveDesktopMenuListMaxHeight(
        Math.min(viewportHeight, viewportBottom - actualSubmenuViewportTop),
        DESKTOP_SUBMENU_VERTICAL_CHROME,
      );
    }

    setDesktopSubmenuSide(nextSubmenuSide);
    setDesktopSubmenuTop(nextSubmenuTop);
    setDesktopSubmenuWidth(nextSubmenuWidth);
    setDesktopGroupListMaxHeight(nextGroupListMaxHeight);
    setDesktopSubmenuListMaxHeight(nextSubmenuListMaxHeight);
  }, [activeDesktopGroup, hasDesktopModelSubmenu, isMobile, open]);

  React.useLayoutEffect(() => {
    updateDesktopSubmenuMetrics();

    if (!open || isMobile) {
      return;
    }

    window.addEventListener("resize", updateDesktopSubmenuMetrics);
    window.addEventListener("scroll", updateDesktopSubmenuMetrics, true);
    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", updateDesktopSubmenuMetrics);
        window.removeEventListener("scroll", updateDesktopSubmenuMetrics, true);
      };
    }

    const observer = new ResizeObserver(updateDesktopSubmenuMetrics);
    if (desktopMenuRootRef.current) {
      observer.observe(desktopMenuRootRef.current);
    }
    if (desktopGroupMenuRef.current) {
      observer.observe(desktopGroupMenuRef.current);
    }
    if (desktopSubmenuRef.current) {
      observer.observe(desktopSubmenuRef.current);
    }
    const activeGroupButton = activeDesktopGroup
      ? desktopGroupItemRefs.current.get(activeDesktopGroup.key)
      : null;
    if (activeGroupButton) {
      observer.observe(activeGroupButton);
    }

    return () => {
      window.removeEventListener("resize", updateDesktopSubmenuMetrics);
      window.removeEventListener("scroll", updateDesktopSubmenuMetrics, true);
      observer.disconnect();
    };
  }, [activeDesktopGroup, hasDesktopModelSubmenu, isMobile, open, updateDesktopSubmenuMetrics]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        const nextScope = selectedModel?.modelScope === "user" ? "user" : "platform";
        setScopeTab(nextScope);
        const scopedGroups = allModelGroups.filter((group) =>
          group.items.some((item) => (item.modelScope ?? "platform") === nextScope),
        );
        setActiveGroupKey(selectedGroupKey || scopedGroups[0]?.key || "");
        setMobileGroupKey(null);
      }
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [allModelGroups, onOpenChange, selectedGroupKey, selectedModel],
  );

  const selectDesktopGroup = React.useCallback((groupKey: string) => {
    if (groupKey === activeDesktopGroupKey) {
      return;
    }
    setActiveGroupKey(groupKey);
  }, [activeDesktopGroupKey]);

  const triggerIdentity = selectedModel
    ? resolveModelIdentity({
      code: selectedModel.platformModelName,
      vendor: selectedModel.vendor,
      icon: selectedModel.icon,
    })
    : null;
  const triggerIconURL = triggerIdentity ? resolveModelIconURL(triggerIdentity.modelIcon) : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        ref={triggerRef}
        disabled={disabled || models.length === 0}
        aria-label={t("modelSelectPlaceholder")}
        className={cn(
          "flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
          "[&_svg]:shrink-0",
          className,
        )}
      >
        {selectedModel ? (
          <>
            <ModelIcon iconUrl={triggerIconURL} label={selectedModel.platformModelName} size={14} />
            <span className="min-w-0 flex-1 truncate" title={selectedModel.platformModelName}>
              {selectedModel.platformModelName}
            </span>
            <CanvasModelCapabilityBadge model={selectedModel} />
          </>
        ) : (
          <>
            <Sparkles className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
            <span className="text-muted-foreground">{t("modelSelectPlaceholder")}</span>
          </>
        )}
        <ChevronsUpDown className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
      </PopoverTrigger>
      <PopoverContent
        data-canvas-ui="model-select"
        align={align}
        side={side}
        sideOffset={DESKTOP_MODEL_MENU_SIDE_OFFSET}
        collisionPadding={MODEL_MENU_COLLISION_PADDING}
        onOpenAutoFocus={(event) => {
          if (!isMobile && selectedModelButtonRef.current) {
            event.preventDefault();
            selectedModelButtonRef.current.focus();
          }
        }}
        className={cn(
          "relative overflow-visible rounded-xl",
          isMobile
            ? "w-[min(20rem,calc(100vw-3rem))] p-1.5"
            : "w-[min(14rem,calc(100vw-3rem))] border-0 bg-transparent p-0 shadow-none",
        )}
      >
        <div className="mb-1.5 grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
          {(["platform", "user"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={cn(
                "h-7 rounded-md text-[11px] font-medium transition-colors",
                scopeTab === scope ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setScopeTab(scope);
                setActiveGroupKey("");
                setMobileGroupKey(null);
              }}
            >
              {scope === "platform" ? t("modelScopePlatform") : t("modelScopeUser")}
            </button>
          ))}
        </div>
        {isMobile ? (
          <>
            <div className="flex h-7 items-center justify-between gap-2 px-2">
              {mobileGroup ? (
                <button
                  type="button"
                  className="-ml-1.5 flex h-7 min-w-0 items-center gap-0.5 rounded-md px-0.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                  onClick={() => setMobileGroupKey(null)}
                >
                  <ChevronLeft className="size-3.5" strokeWidth={1.8} />
                  <span>{t("modelGroup")}</span>
                </button>
              ) : (
                <span className="text-[11px] font-medium text-foreground">{t("modelGroup")}</span>
              )}
              <span className="min-w-0 truncate text-right text-[10px] font-medium text-muted-foreground">
                {mobileGroup ? mobileGroup.channelLabel || mobileGroup.label : selectedGroupLabel}
              </span>
            </div>
            {modelGroups.length === 0 ? (
              <div className="px-2 py-3 text-[11px] leading-4 text-muted-foreground">
                {t("modelGroupEmpty")}
              </div>
            ) : (
              <ModelMenuScrollContainer>
                {mobileGroup ? (
                  <div className="flex flex-col gap-0.5">
                    {mobileGroup.items.map((item) => (
                      <CanvasModelMenuItem
                        key={canvasModelKey(item)}
                        model={item}
                        selected={canvasModelKey(item) === selectedKey}
                        onSelect={() => {
                          onSelect(item);
                          handleOpenChange(false);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {modelGroups.map((group, index) => {
                      const selectedGroup = group.key === selectedGroupKey;
                      const previousGroup = modelGroups[index - 1];
                      const showChannelHeading = Boolean(
                        group.channelKey &&
                        (!previousGroup || previousGroup.channelKey !== group.channelKey),
                      );
                      const channelCollapsed = Boolean(
                        group.channelKey && collapsedChannelKeys.has(group.channelKey),
                      );
                      const groupIconURL = resolveModelIconURL(group.icon);
                      return (
                        <React.Fragment key={group.key}>
                          {showChannelHeading ? (
                            <button
                              type="button"
                              className="flex h-7 w-full items-center justify-between px-2 pt-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-foreground"
                              onClick={() => {
                                if (!group.channelKey) return;
                                setCollapsedChannelKeys((current) => {
                                  const next = new Set(current);
                                  if (next.has(group.channelKey!)) next.delete(group.channelKey!);
                                  else next.add(group.channelKey!);
                                  return next;
                                });
                              }}
                            >
                              <span className="min-w-0 truncate">{group.channelLabel}</span>
                              {channelCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                            </button>
                          ) : null}
                          {!channelCollapsed ? (
                            <button
                              type="button"
                              className={cn(
                                "flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 py-0 text-left text-[11px] font-medium outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                                selectedGroup ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                              )}
                              onClick={() => setMobileGroupKey(group.key)}
                            >
                              <ModelIcon iconUrl={groupIconURL} label={group.label} />
                              <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{group.items.length}</span>
                            </button>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}
              </ModelMenuScrollContainer>
            )}
          </>
        ) : (
          <div ref={desktopMenuRootRef} className="relative min-w-0">
            {hasDesktopModelSubmenu ? (
              <div
                ref={desktopSubmenuRef}
                style={{
                  top: desktopSubmenuTop,
                  width: desktopSubmenuWidth,
                } as React.CSSProperties}
                className={cn(
                  "absolute flex max-h-[calc(100dvh-3rem)] flex-col overflow-hidden rounded-xl border-[0.5px] border-border bg-popover p-1.5 shadow-xs",
                  desktopSubmenuSide === "right" ? "left-[calc(100%+0.5rem)]" : "right-[calc(100%+0.5rem)]",
                )}
              >
                <ModelMenuScrollContainer maxHeight={desktopSubmenuListMaxHeight}>
                  <div className="flex flex-col gap-0.5">
                    {activeModels.map((item) => (
                      <CanvasModelMenuItem
                        key={canvasModelKey(item)}
                        model={item}
                        selected={canvasModelKey(item) === selectedKey}
                        buttonRef={canvasModelKey(item) === selectedKey ? selectedModelButtonRef : undefined}
                        onSelect={() => {
                          onSelect(item);
                          handleOpenChange(false);
                        }}
                      />
                    ))}
                  </div>
                </ModelMenuScrollContainer>
              </div>
            ) : null}

            <div
              ref={desktopGroupMenuRef}
              className="flex min-w-0 max-h-[calc(100dvh-3rem)] flex-col overflow-hidden rounded-xl border-[0.5px] border-border bg-popover p-1.5 shadow-xs"
            >
              <div className="flex h-7 shrink-0 items-center justify-between gap-3 px-2">
                <span className="text-[11px] font-medium text-foreground">{t("modelGroup")}</span>
                <span className="min-w-0 truncate text-[10px] font-medium text-muted-foreground" title={selectedGroupLabel}>
                  {selectedGroupLabel}
                </span>
              </div>
              {modelGroups.length === 0 ? (
                <div className="px-2 py-3 text-[11px] leading-4 text-muted-foreground">
                  {t("modelGroupEmpty")}
                </div>
              ) : (
                <div className="min-h-0 min-w-0">
                  <ModelMenuScrollContainer maxHeight={desktopGroupListMaxHeight} onScroll={updateDesktopSubmenuMetrics}>
                    <div className="flex flex-col gap-0.5">
                      {modelGroups.map((group, index) => {
                        const selectedGroup = group.key === selectedGroupKey;
                        const activeGroup = group.key === activeDesktopGroup?.key;
                        const groupIconURL = resolveModelIconURL(group.icon);
                        const previousGroup = modelGroups[index - 1];
                        const showChannelHeading = Boolean(
                          group.channelKey &&
                          (!previousGroup || previousGroup.channelKey !== group.channelKey),
                        );
                        const channelCollapsed = Boolean(
                          group.channelKey && collapsedChannelKeys.has(group.channelKey),
                        );
                        return (
                          <React.Fragment key={group.key}>
                            {showChannelHeading ? (
                              <button
                                type="button"
                                className="flex h-7 w-full items-center justify-between px-2 pt-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-foreground"
                                onClick={() => {
                                  if (!group.channelKey) return;
                                  setCollapsedChannelKeys((current) => {
                                    const next = new Set(current);
                                    if (next.has(group.channelKey!)) next.delete(group.channelKey!);
                                    else next.add(group.channelKey!);
                                    return next;
                                  });
                                }}
                              >
                                <span className="min-w-0 truncate">{group.channelLabel}</span>
                                {channelCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                              </button>
                            ) : null}
                            {!channelCollapsed ? (
                              <button
                                type="button"
                                ref={(node) => {
                                  if (node) {
                                    desktopGroupItemRefs.current.set(group.key, node);
                                    return;
                                  }
                                  desktopGroupItemRefs.current.delete(group.key);
                                }}
                                className={cn(
                                  "flex h-7 w-full items-center gap-2 rounded-md px-2 py-0 text-left text-[11px] font-medium outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                                  activeGroup ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                                  selectedGroup && !activeGroup ? "text-foreground" : null,
                                )}
                                onMouseEnter={() => selectDesktopGroup(group.key)}
                                onFocus={() => selectDesktopGroup(group.key)}
                                onClick={() => selectDesktopGroup(group.key)}
                              >
                                <ModelIcon iconUrl={groupIconURL} label={group.label} />
                                <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{group.items.length}</span>
                                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground/65 transition-transform", activeGroup && "rotate-90")} strokeWidth={1.8} />
                              </button>
                            ) : null}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </ModelMenuScrollContainer>
                </div>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
