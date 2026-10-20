"use client";

import { Braces, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  countActiveImageOptions,
  deleteOptionAtPath,
  getOptionAtPath,
  resolveCanvasMediaControls,
  setOptionAtPath,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import { CanvasCustomParamsDialog } from "@/features/canvas/components/canvas-custom-params-dialog";
import type { CanvasMediaType } from "@/features/canvas/model/canvas-types";
import type { ModelOptionControl } from "@/features/chat";
import { cn } from "@/lib/utils";
import type { ConversationOptions } from "@/shared/api/conversation-types";

const DEFAULT_VALUE = "__canvas_default__";
const CUSTOM_VALUE = "__canvas_custom__";

function optionPathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function CanvasImageParams({
  model,
  mediaType = "image",
  options,
  onOptionsChange,
  resultCount,
  onResultCountChange,
  onOpenChange,
  disabled,
  iconOnly,
  className,
}: {
  model: CanvasModelOption | null;
  mediaType?: CanvasMediaType;
  options: ConversationOptions;
  onOptionsChange: (options: ConversationOptions) => void;
  resultCount: number;
  onResultCountChange: (count: number) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  // 紧凑模式：只显示图标（已设参数时带角标），用于对话输入条等横向空间受限的位置
  iconOnly?: boolean;
  className?: string;
}) {
  const t = useTranslations("canvas");
  const tOptionLabels = useTranslations("chat.optionLabels");
  const controls = React.useMemo(() => resolveCanvasMediaControls(model, mediaType), [mediaType, model]);
  const activeCount = React.useMemo(
    () => countActiveImageOptions(controls, options),
    [controls, options],
  );
  const [customParamsOpen, setCustomParamsOpen] = React.useState(false);
  // 视频由上游单产物输出，生成数量不可配
  const isVideo = mediaType === "video";
  // 选择"自定义"后切换为输入框的 select 控件（如视频分辨率）
  const [customSelectPaths, setCustomSelectPaths] = React.useState<ReadonlySet<string>>(() => new Set());

  const resolveLabel = React.useCallback(
    (control: ModelOptionControl): string => {
      if (control.label?.trim()) {
        return control.label.trim();
      }
      // 复用普通对话的参数文案；缺失时回退为原始路径
      const translationKey = control.path.replaceAll(".", "__");
      const hasKey = typeof tOptionLabels.has === "function" ? tOptionLabels.has(translationKey) : false;
      return hasKey ? tOptionLabels(translationKey) : control.path;
    },
    [tOptionLabels],
  );

  // 候选值文案：键为「控件路径（. 替换为 __）__候选值」，缺失时回退原始候选值。
  const resolveValueLabel = React.useCallback(
    (path: string, value: string): string => {
      const translationKey = `${path.replaceAll(".", "__")}__${value}`;
      const hasKey = typeof tOptionLabels.has === "function" ? tOptionLabels.has(translationKey) : false;
      return hasKey ? tOptionLabels(translationKey) : value;
    },
    [tOptionLabels],
  );

  const updateValue = React.useCallback(
    (path: string, value: unknown) => {
      const segments = optionPathSegments(path);
      onOptionsChange(
        value === undefined
          ? deleteOptionAtPath(options, segments)
          : setOptionAtPath(options, segments, value),
      );
    },
    [onOptionsChange, options],
  );

  const totalCount = isVideo ? controls.length : controls.length + 1;
  const displayCount = activeCount + (!isVideo && resultCount > 1 ? 1 : 0);

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        title={isVideo ? t("videoParams") : t("imageParams")}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
          iconOnly && "relative size-9 justify-center rounded-xl px-0",
          className,
        )}
      >
        <SlidersHorizontal className={cn("text-muted-foreground", iconOnly ? "size-4" : "size-3.5")} strokeWidth={1.8} />
        {iconOnly ? (
          // 紧凑模式用角标提示「已设参数」，避免在图标按钮上挤文字
          displayCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
              {displayCount}
            </span>
          ) : null
        ) : (
          <>
            <span className="hidden sm:inline">{isVideo ? t("videoParams") : t("imageParams")}</span>
            <span className="tabular-nums text-muted-foreground">
              {displayCount}/{totalCount}
            </span>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        data-canvas-ui="image-params"
        align="start"
        side="top"
        sideOffset={8}
        className="w-72 p-2"
        // 高级参数弹窗渲染在 Popover 之外，打开期间不能因为交互落在弹窗上而关掉本面板
        onInteractOutside={(event) => {
          if (customParamsOpen) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (customParamsOpen) {
            event.preventDefault();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
          <p className="text-xs font-medium text-foreground/80">{isVideo ? t("videoParams") : t("imageParams")}</p>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => setCustomParamsOpen(true)}
            >
              <Braces className="size-3" strokeWidth={1.8} />
              {t("imageParamsAdvanced")}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                onOptionsChange({});
                onResultCountChange(1);
              }}
            >
              <RotateCcw className="size-3" strokeWidth={1.8} />
              {t("imageParamsReset")}
            </button>
          </div>
        </div>
        <div className="max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
          {!isVideo ? (
            <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-2">
              <p className="truncate text-xs text-foreground/80">{t("resultCount")}</p>
              <Select value={String(resultCount)} onValueChange={(value) => onResultCountChange(Number(value))}>
                <SelectTrigger size="sm" aria-label={t("resultCount")} className="w-full tabular-nums">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent data-canvas-ui="result-count-select">
                  {[1, 2, 3, 4].map((count) => (
                    <SelectItem key={count} value={String(count)}>
                      {count}×
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {controls.map((control) => {
            const segments = optionPathSegments(control.path);
            const value = getOptionAtPath(options, segments);
            const selectValues = (control.options ?? []).map((item) => item.trim()).filter(Boolean);
            const isSelect = (control.type ?? (selectValues.length > 0 ? "select" : "text")) === "select";
            const isNumber = control.type === "number";
            // 布尔参数用「默认 / 是 / 否」下拉，比自由文本输入更明确
            const isBoolean = control.type === "boolean";
            const label = resolveLabel(control);
            const showSelect = isSelect && selectValues.length > 0 && !customSelectPaths.has(control.path);

            return (
              <div key={control.path} className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs text-foreground/80" title={label}>
                    {label}
                  </p>
                  <code className="block truncate font-mono text-[10px] leading-3 text-muted-foreground">
                    {control.path}
                  </code>
                </div>
                {isBoolean ? (
                  <Select
                    value={typeof value === "boolean" ? String(value) : DEFAULT_VALUE}
                    onValueChange={(next) => {
                      updateValue(control.path, next === DEFAULT_VALUE ? undefined : next === "true");
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue placeholder={t("imageParamsDefault")} />
                    </SelectTrigger>
                    <SelectContent data-canvas-ui="image-params-select">
                      <SelectItem value={DEFAULT_VALUE}>{t("imageParamsDefault")}</SelectItem>
                      <SelectItem value="true">{t("paramYes")}</SelectItem>
                      <SelectItem value="false">{t("paramNo")}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : showSelect ? (
                  <Select
                    value={
                      typeof value === "string" || typeof value === "number"
                        ? String(value)
                        : DEFAULT_VALUE
                    }
                    onValueChange={(next) => {
                      if (next === CUSTOM_VALUE) {
                        setCustomSelectPaths((prev) => new Set(prev).add(control.path));
                        return;
                      }
                      setCustomSelectPaths((prev) => {
                        if (!prev.has(control.path)) {
                          return prev;
                        }
                        const nextPaths = new Set(prev);
                        nextPaths.delete(control.path);
                        return nextPaths;
                      });
                      updateValue(control.path, next === DEFAULT_VALUE ? undefined : next);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue placeholder={t("imageParamsDefault")} />
                    </SelectTrigger>
                    <SelectContent data-canvas-ui="image-params-select">
                      <SelectItem value={DEFAULT_VALUE}>{t("imageParamsDefault")}</SelectItem>
                      {selectValues.map((item) => (
                        <SelectItem key={item} value={item}>
                          {resolveValueLabel(control.path, item)}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_VALUE}>{t("imageParamsCustom")}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    className="h-8 text-xs"
                    inputMode={isNumber ? "decimal" : undefined}
                    placeholder={control.placeholder ?? t("imageParamsDefault")}
                    value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (!next.trim()) {
                        if (isSelect) {
                          setCustomSelectPaths((prev) => {
                            if (!prev.has(control.path)) {
                              return prev;
                            }
                            const nextPaths = new Set(prev);
                            nextPaths.delete(control.path);
                            return nextPaths;
                          });
                        }
                        updateValue(control.path, undefined);
                        return;
                      }
                      if (isNumber) {
                        const parsed = Number(next);
                        updateValue(control.path, Number.isFinite(parsed) ? parsed : next);
                        return;
                      }
                      updateValue(control.path, next);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <CanvasCustomParamsDialog
          open={customParamsOpen}
          onOpenChange={setCustomParamsOpen}
          options={options}
          onSave={onOptionsChange}
        />
      </PopoverContent>
    </Popover>
  );
}
