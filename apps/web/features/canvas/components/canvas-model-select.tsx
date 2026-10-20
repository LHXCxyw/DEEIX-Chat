"use client";

import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, KeyRound, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
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
  resolveModelOptionIconUrl,
  resolveModelOptionLabel,
  resolveModelPresentationGroup,
} from "@/entities/model";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import {
  resolveDesktopMenuListMaxHeight,
  resolveDesktopModelMenuListMaxHeight,
} from "@/features/chat";

// 与对话模型选择器（ChatModelPicker）同构：用户自带密钥的模型按提供商分组（键 personal:<providerName>），
// 平台模型按展示分组；分组面板与模型列表面板相互独立（二级面板绝对定位），
// hover 切换分组时互不影响高度。同名模型按身份键（canvasModelKey）区分来源接口。
type CanvasModelGroup = {
  key: string;
  label: string;
  icon: string;
  personal: boolean;
  items: CanvasModelOption[];
};

// 分组展示信息：用户模型与对话选择器一致按 personal:<providerName> 分组，平台模型沿用展示分组
function resolveCanvasGroupPresentation(item: CanvasModelOption): {
  key: string;
  label: string;
  icon: string;
  personal: boolean;
} {
  if (item.modelScope === "user") {
    const providerName = item.personalProviderName?.trim() ?? "";
    return {
      key: `personal:${providerName}`,
      label: providerName || resolveModelOptionLabel(item.platformModelName),
      icon: item.personalProviderIcon,
      personal: true,
    };
  }
  const group = resolveModelPresentationGroup(item);
  return { key: group.key, label: group.label, icon: group.icon, personal: false };
}

function resolveCanvasModelGroups(models: ReadonlyArray<CanvasModelOption>): CanvasModelGroup[] {
  const groupMap = new Map<
    string,
    {
      label: string;
      icon: string;
      personal: boolean;
      items: CanvasModelOption[];
    }
  >();
  for (const item of models) {
    const presentation = resolveCanvasGroupPresentation(item);
    const group = groupMap.get(presentation.key);
    if (group) {
      group.items.push(item);
      continue;
    }
    groupMap.set(presentation.key, {
      label: presentation.label,
      icon: presentation.icon,
      personal: presentation.personal,
      items: [item],
    });
  }

  return Array.from(groupMap.entries()).map(([key, group]) => ({ key, ...group }));
}

// 用户自带密钥分组的图标缺失时回退到 Lucide KeyRound（与对话选择器一致）
function PersonalGroupIcon() {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
      <KeyRound className="size-3.5" strokeWidth={1.7} />
    </span>
  );
}

// 区分用户自带密钥分组与同厂商的平台分组（与对话选择器一致）
function PersonalGroupBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="h-4 shrink-0 px-1 font-normal">
      {label}
    </Badge>
  );
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

// 把弹层内部测得的矩形映射回弹层“落定后”的布局盒。
// Radix 打开弹层时带有缩放与位移动画，动画期间测得的矩形已被变换，
// 据此换算出的位置会在动画结束后跳变；而承载弹层的 popper 包装层不参与动画，
// 其位置恰好等于内容未变换时的落点（与对话侧选择器同构）。
function createCanvasLayoutRectReader(inside: HTMLElement): (element: Element) => DOMRect {
  const content = inside.closest<HTMLElement>("[data-slot=popover-content]");
  const wrapper = content?.parentElement;
  const contentRect = content?.getBoundingClientRect();
  const scale = content && contentRect && content.offsetWidth > 0 ? contentRect.width / content.offsetWidth : 0;
  if (!wrapper || !contentRect || scale <= 0) {
    return (element) => element.getBoundingClientRect();
  }
  const wrapperRect = wrapper.getBoundingClientRect();
  return (element) => {
    const rect = element.getBoundingClientRect();
    return new DOMRect(
      wrapperRect.left + (rect.left - contentRect.left) / scale,
      wrapperRect.top + (rect.top - contentRect.top) / scale,
      rect.width / scale,
      rect.height / scale,
    );
  };
}

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
  // 模型名统一剥离 personal: 前缀（与对话选择器一致）
  const platformModelName = resolveModelOptionLabel(model.platformModelName);
  const iconURL = React.useMemo(() => resolveModelOptionIconUrl(model), [model]);

  // 与对话模型选择器的列表项一致：图标 + 截断的模型名 + 勾选；
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
        <span className="min-w-0 flex-1 truncate leading-4">{platformModelName}</span>
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
        data-model-menu-viewport=""
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
  const [desktopSubmenuSide, setDesktopSubmenuSide] = React.useState<"right" | "left">("right");
  const [desktopSubmenuTop, setDesktopSubmenuTop] = React.useState(0);
  const [desktopSubmenuWidth, setDesktopSubmenuWidth] = React.useState(DESKTOP_MODEL_MENU_WIDTH);
  const [desktopGroupListMaxHeight, setDesktopGroupListMaxHeight] = React.useState(320);
  const [desktopSubmenuListMaxHeight, setDesktopSubmenuListMaxHeight] = React.useState(320);
  // Radix 把弹层内容挂进 Portal 比 open 变化晚一次提交，首次布局副作用里 ref 仍为空；
  // 该标记在节点挂载后翻转，驱动度量重算（与对话侧选择器同构）。
  const [desktopMenuMounted, setDesktopMenuMounted] = React.useState(false);
  const desktopMenuRootRef = React.useRef<HTMLDivElement | null>(null);
  const attachDesktopMenuRoot = React.useCallback((node: HTMLDivElement | null) => {
    desktopMenuRootRef.current = node;
    setDesktopMenuMounted(node !== null);
  }, []);
  const desktopGroupMenuRef = React.useRef<HTMLDivElement | null>(null);
  const desktopSubmenuRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const selectedModelButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const desktopGroupItemRefs = React.useRef(new Map<string, HTMLButtonElement>());

  const selectedKey = selectedModel ? canvasModelKey(selectedModel) : "";
  // 平台模型与用户自带密钥模型合并为一份列表：用户模型按 personal:<provider> 分组并带“自有”徽标
  const modelGroups = React.useMemo(() => resolveCanvasModelGroups(models), [models]);
  // 选中模型所属分组：与列表同一套分组规则（用户模型按 personal:<providerName> 分组）
  const selectedGroupKey = React.useMemo(
    () => (selectedModel ? resolveCanvasGroupPresentation(selectedModel).key : ""),
    [selectedModel],
  );
  const selectedGroupLabel = React.useMemo(
    () => (selectedModel ? resolveCanvasGroupPresentation(selectedModel).label : ""),
    [selectedModel],
  );
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
      // 保留最后一次布局：Radix 在关闭动画期间仍挂载内容，此时重置 side/top 会让二级浮层
      // 在淡出过程中跳位；重新打开时会在绘制前于布局副作用里整体重算。
      return;
    }

    const menuRoot = desktopMenuRootRef.current;
    const groupMenu = desktopGroupMenuRef.current;
    if (!menuRoot || !groupMenu) {
      return;
    }

    const layoutRect = createCanvasLayoutRectReader(menuRoot);
    const menuRootRect = layoutRect(menuRoot);
    const groupMenuRect = layoutRect(groupMenu);
    const submenu = desktopSubmenuRef.current;
    const submenuScrollViewport = submenu?.querySelector<HTMLElement>("[data-model-menu-viewport]") ?? null;
    const activeGroupButton = activeDesktopGroup
      ? desktopGroupItemRefs.current.get(activeDesktopGroup.key)
      : null;
    const activeGroupRect = activeGroupButton ? layoutRect(activeGroupButton) : undefined;
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
      // 外框高度取自未裁剪的滚动内容高度：若改用已按 max-height 收缩后的渲染高度，
      // 每轮重算都会把二级浮层再往上顶一个 chrome，导致其逐帧“爬升”。
      const submenuChrome = submenu
        ? Math.max(DESKTOP_SUBMENU_VERTICAL_CHROME, submenu.offsetHeight - (submenuScrollViewport?.offsetHeight ?? 0))
        : DESKTOP_SUBMENU_VERTICAL_CHROME;
      const submenuContentHeight = submenuScrollViewport?.scrollHeight ?? nextGroupListMaxHeight;
      const submenuOuterHeight = Math.min(submenuContentHeight + submenuChrome, viewportHeight);
      const maxViewportTop = Math.max(viewportTop, viewportBottom - submenuOuterHeight);
      // 先按视口坐标锚定到激活分组按钮，再换算成 menuRoot 内的偏移
      // （menuRoot 可能暂时位于 viewportTop 之上，故以视口坐标钳制后再转换）。
      const preferredSubmenuViewportTop = Math.min(
        Math.max(activeGroupRect.top, viewportTop),
        maxViewportTop,
      );
      nextSubmenuTop = preferredSubmenuViewportTop - menuRootRect.top;
      const actualSubmenuViewportTop = menuRootRect.top + nextSubmenuTop;
      nextSubmenuListMaxHeight = resolveDesktopMenuListMaxHeight(
        Math.min(viewportHeight, viewportBottom - actualSubmenuViewportTop),
        submenuChrome,
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
    // Radix 通过改写弹层包装层的 transform 来定位：首帧以及触发按钮移动时（如输入条长高）
    // 都会变，而 transform 变化不触发 ResizeObserver，因此直接观察该 style。
    const popperWrapper = desktopMenuRootRef.current?.closest("[data-slot=popover-content]")?.parentElement;
    const moveObserver = new MutationObserver(updateDesktopSubmenuMetrics);
    if (popperWrapper) {
      moveObserver.observe(popperWrapper, { attributes: true, attributeFilter: ["style"] });
    }
    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", updateDesktopSubmenuMetrics);
        window.removeEventListener("scroll", updateDesktopSubmenuMetrics, true);
        moveObserver.disconnect();
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
      moveObserver.disconnect();
      observer.disconnect();
    };
  }, [activeDesktopGroup, desktopMenuMounted, hasDesktopModelSubmenu, isMobile, open, updateDesktopSubmenuMetrics]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setActiveGroupKey(selectedGroupKey || modelGroups[0]?.key || "");
        setMobileGroupKey(null);
      }
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [modelGroups, onOpenChange, selectedGroupKey],
  );

  const selectDesktopGroup = React.useCallback((groupKey: string) => {
    if (groupKey === activeDesktopGroupKey) {
      return;
    }
    setActiveGroupKey(groupKey);
  }, [activeDesktopGroupKey]);

  // 触发按钮的模型名同样剥离 personal: 前缀
  const triggerIconURL = selectedModel ? resolveModelOptionIconUrl(selectedModel) : null;
  const triggerLabel = selectedModel ? resolveModelOptionLabel(selectedModel.platformModelName) : "";

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
            <ModelIcon iconUrl={triggerIconURL} label={triggerLabel} size={14} />
            <span className="min-w-0 flex-1 truncate" title={triggerLabel}>
              {triggerLabel}
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
                {mobileGroup ? mobileGroup.label : selectedGroupLabel}
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
                  <div className="flex flex-col gap-0.5">
                    {modelGroups.map((group) => {
                      const selectedGroup = group.key === selectedGroupKey;
                      const groupIconURL = resolveModelIconURL(group.icon);
                      return (
                        <button
                          key={group.key}
                          type="button"
                          className={cn(
                            "flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 py-0 text-left text-[11px] font-medium outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                            selectedGroup ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                          )}
                          onClick={() => setMobileGroupKey(group.key)}
                        >
                          {group.personal && !group.icon ? <PersonalGroupIcon /> : <ModelIcon iconUrl={groupIconURL} label={group.label} />}
                          <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                          {group.personal ? <PersonalGroupBadge label={t("personalBadge")} /> : null}
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{group.items.length}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </ModelMenuScrollContainer>
            )}
          </>
        ) : (
          <div ref={attachDesktopMenuRoot} className="relative min-w-0">
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
                      {modelGroups.map((group) => {
                        const selectedGroup = group.key === selectedGroupKey;
                        const activeGroup = group.key === activeDesktopGroup?.key;
                        const groupIconURL = resolveModelIconURL(group.icon);
                        return (
                          <button
                            key={group.key}
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
                            {group.personal && !group.icon ? <PersonalGroupIcon /> : <ModelIcon iconUrl={groupIconURL} label={group.label} />}
                            <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                            {group.personal ? <PersonalGroupBadge label={t("personalBadge")} /> : null}
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{group.items.length}</span>
                            <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground/65 transition-transform", activeGroup && "rotate-90")} strokeWidth={1.8} />
                          </button>
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
