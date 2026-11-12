"use client";

import { Ellipsis, Keyboard, RotateCcw, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { createPortal } from "react-dom";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import type { CanvasModelOption } from "@/features/canvas/model/canvas-image-options";
import {
  DEFAULT_IMAGE_PROMPT_ENHANCEMENT,
  DEFAULT_VIDEO_PROMPT_ENHANCEMENT,
  loadPromptEnhancement,
  OPEN_PROMPT_ENHANCEMENT_EVENT,
  savePromptEnhancement,
  type CanvasPromptEnhancement,
} from "@/features/canvas/model/canvas-prompt";
import { cn } from "@/lib/utils";

// 画布右上角菜单：提示词优化配置与快捷键面板都在这里打开。
// 快捷键固定在右侧显示，带关闭按钮；配置项持久化到本地。
export function CanvasSettingsMenu({
  shortcuts,
  textModels,
}: {
  shortcuts: ReadonlyArray<[string, string]>;
  textModels: ReadonlyArray<CanvasModelOption>;
}) {
  const t = useTranslations("canvas.settingsMenu");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [config, setConfig] = React.useState<CanvasPromptEnhancement>(() => ({
    image: DEFAULT_IMAGE_PROMPT_ENHANCEMENT,
    video: DEFAULT_VIDEO_PROMPT_ENHANCEMENT,
    model: null,
  }));
  // 面板挂到 body：避免被工具栏的定位/层叠上下文限制，导致排版挤进工具栏
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    setConfig(loadPromptEnhancement());
  }, []);

  // 对话框内点「AI 优化」但尚未配置模型时，跳到本面板提示选择文本模型
  React.useEffect(() => {
    const open = () => {
      setMenuOpen(false);
      setConfig(loadPromptEnhancement());
      setDialogOpen(true);
    };
    window.addEventListener(OPEN_PROMPT_ENHANCEMENT_EVENT, open);
    return () => window.removeEventListener(OPEN_PROMPT_ENHANCEMENT_EVENT, open);
  }, []);

  const selectedTextModel = React.useMemo(
    () => textModels.find((item) => item.platformModelName === config.model) ?? null,
    [config.model, textModels],
  );

  const save = () => {
    savePromptEnhancement(config);
    setDialogOpen(false);
  };

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-canvas-ui="settings-trigger"
            aria-label={t("open")}
            title={t("open")}
            className="pointer-events-auto flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Ellipsis className="size-4" strokeWidth={1.8} />
          </button>
        </PopoverTrigger>
        <PopoverContent data-canvas-ui="settings-menu" align="end" side="bottom" sideOffset={8} className="w-52 p-1.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-accent"
            onClick={() => {
              setMenuOpen(false);
              setDialogOpen(true);
            }}
          >
            <Sparkles className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
            {t("promptEnhancement")}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-accent"
            onClick={() => {
              setMenuOpen(false);
              setShortcutsOpen(true);
            }}
          >
            <Keyboard className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
            {t("shortcuts")}
          </button>
        </PopoverContent>
      </Popover>

      {/* 提示词优化配置 */}
      {mounted && dialogOpen ? createPortal(
        <div data-canvas-ui="prompt-enhancement-dialog" className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-background/40 p-4 backdrop-blur-sm" onPointerDown={(event) => event.stopPropagation()}>
          <div className="w-full max-w-lg rounded-2xl border border-border/60 bg-background/95 p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t("promptEnhancement")}</h2>
              <button type="button" aria-label={t("close")} title={t("close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setDialogOpen(false)}>
                <X className="size-4" strokeWidth={1.8} />
              </button>
            </div>
            <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{t("promptEnhancementHint")}</p>
            <div className="mb-3 space-y-1.5">
              <span className="text-[11px] font-medium text-foreground/80">{t("textModel")}</span>
              {textModels.length > 0 ? (
                <CanvasModelSelect
                  models={[...textModels]}
                  selectedModel={selectedTextModel}
                  onSelect={(nextModel) => setConfig((current) => ({ ...current, model: nextModel.platformModelName }))}
                  className="h-9 w-full justify-between rounded-lg border-border/60 bg-background/80"
                />
              ) : (
                <p className="rounded-lg bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">{t("noTextModels")}</p>
              )}
              <p className="text-[10px] leading-relaxed text-muted-foreground/80">{t("textModelHint")}</p>
            </div>
            <label className="block space-y-1.5">
              <span className="text-[11px] font-medium text-foreground/80">{t("imageEnhancement")}</span>
              <textarea
                data-canvas-selectable
                value={config.image}
                className="h-20 w-full resize-none rounded-xl border border-border/60 bg-muted/25 p-2.5 text-xs leading-relaxed outline-none focus:ring-1 focus:ring-primary/30"
                onChange={(event) => setConfig((current) => ({ ...current, image: event.target.value }))}
              />
            </label>
            <label className="mt-3 block space-y-1.5">
              <span className="text-[11px] font-medium text-foreground/80">{t("videoEnhancement")}</span>
              <textarea
                data-canvas-selectable
                value={config.video}
                className="h-20 w-full resize-none rounded-xl border border-border/60 bg-muted/25 p-2.5 text-xs leading-relaxed outline-none focus:ring-1 focus:ring-primary/30"
                onChange={(event) => setConfig((current) => ({ ...current, video: event.target.value }))}
              />
            </label>
            <div className="mt-4 flex items-center justify-between gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => setConfig((current) => ({
                  ...current,
                  image: DEFAULT_IMAGE_PROMPT_ENHANCEMENT,
                  video: DEFAULT_VIDEO_PROMPT_ENHANCEMENT,
                }))}
              >
                <RotateCcw className="size-3.5" strokeWidth={1.8} />
                {t("reset")}
              </button>
              <div className="flex items-center gap-2">
                <button type="button" className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={() => setDialogOpen(false)}>{t("cancel")}</button>
                <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90" onClick={save}>{t("save")}</button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {/* 快捷键面板：打开时固定在右侧，可关闭 */}
      {mounted && shortcutsOpen ? createPortal(
        <aside
          data-canvas-ui="shortcut-panel"
          aria-label={t("shortcuts")}
          className="pointer-events-auto fixed right-3 top-20 z-50 w-64 rounded-2xl border border-border/60 bg-background/95 p-3 shadow-2xl backdrop-blur-2xl"
        >
          <div className="mb-2.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground/85">
              <Keyboard className="size-3.5 text-primary/80" strokeWidth={1.8} />
              {t("shortcuts")}
            </span>
            <button type="button" aria-label={t("close")} title={t("close")} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={() => setShortcutsOpen(false)}>
              <X className="size-3.5" strokeWidth={1.8} />
            </button>
          </div>
          <div className={cn("grid gap-1.5")}>
            {shortcuts.map(([keys, label]) => (
              <span key={keys} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/85">
                <span className="truncate">{label}</span>
                <kbd className="shrink-0 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 font-mono text-[9px] text-foreground/70">{keys}</kbd>
              </span>
            ))}
          </div>
        </aside>,
        document.body,
      ) : null}
    </>
  );
}
