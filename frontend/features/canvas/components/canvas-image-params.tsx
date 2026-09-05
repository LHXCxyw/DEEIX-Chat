"use client";

import { RotateCcw, SlidersHorizontal } from "lucide-react";
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
  resolveCanvasImageControls,
  setOptionAtPath,
} from "@/features/canvas/model/canvas-image-options";
import type { ChatModelOption, ModelOptionControl } from "@/features/chat/types/chat-runtime";
import { cn } from "@/lib/utils";
import type { ConversationOptions } from "@/shared/api/conversation.types";

const DEFAULT_VALUE = "__canvas_default__";

function optionPathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function CanvasImageParams({
  model,
  options,
  onOptionsChange,
  resultCount,
  onResultCountChange,
  onOpenChange,
  disabled,
  className,
}: {
  model: ChatModelOption | null;
  options: ConversationOptions;
  onOptionsChange: (options: ConversationOptions) => void;
  resultCount: number;
  onResultCountChange: (count: number) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("canvas");
  const tOptionLabels = useTranslations("chat.optionLabels");
  const controls = React.useMemo(() => resolveCanvasImageControls(model), [model]);
  const activeCount = React.useMemo(
    () => countActiveImageOptions(controls, options),
    [controls, options],
  );

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

  const totalCount = controls.length + 1;
  const displayCount = activeCount + (resultCount > 1 ? 1 : 0);

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        title={t("imageParams")}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        <SlidersHorizontal className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
        <span className="hidden sm:inline">{t("imageParams")}</span>
        <span className="tabular-nums text-muted-foreground">
          {displayCount}/{totalCount}
        </span>
      </PopoverTrigger>
      <PopoverContent
        data-canvas-ui="image-params"
        align="start"
        side="top"
        sideOffset={8}
        className="w-72 p-2"
      >
        <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
          <p className="text-xs font-medium text-foreground/80">{t("imageParams")}</p>
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
        <div className="max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
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
          {controls.map((control) => {
            const segments = optionPathSegments(control.path);
            const value = getOptionAtPath(options, segments);
            const selectValues = (control.options ?? []).map((item) => item.trim()).filter(Boolean);
            const isSelect = (control.type ?? (selectValues.length > 0 ? "select" : "text")) === "select";
            const isNumber = control.type === "number";
            const label = resolveLabel(control);

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
                {isSelect && selectValues.length > 0 ? (
                  <Select
                    value={
                      typeof value === "string" || typeof value === "number"
                        ? String(value)
                        : DEFAULT_VALUE
                    }
                    onValueChange={(next) =>
                      updateValue(control.path, next === DEFAULT_VALUE ? undefined : next)
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue placeholder={t("imageParamsDefault")} />
                    </SelectTrigger>
                    <SelectContent data-canvas-ui="image-params-select">
                      <SelectItem value={DEFAULT_VALUE}>{t("imageParamsDefault")}</SelectItem>
                      {selectValues.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
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
      </PopoverContent>
    </Popover>
  );
}
