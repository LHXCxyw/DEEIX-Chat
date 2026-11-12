"use client";

import { AudioLines, ChevronDown, Crop, Expand, Image as ImageIcon, Paintbrush, Sparkles, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import type { CanvasModelOption } from "@/features/canvas/model/canvas-image-options";
import { cn } from "@/lib/utils";

export type AssetToolbarKind = "image" | "video" | "audio";
export type AssetToolbarAction =
  | "inpaint"
  | "outpaint"
  | "crop"
  | "upscale"
  | "extractFrame"
  | "extractAudio"
  | "remove";

function ToolbarAction({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground",
        destructive && "hover:text-destructive",
      )}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

// 素材悬浮工具栏：左侧选择用于改图的模型，右侧按素材类型给出可执行操作。
// 操作只负责发起意图，具体生成由画布新节点完成并自动与素材连线。
export function CanvasAssetToolbar({
  kind,
  models,
  selectedModel,
  onSelectModel,
  onAction,
}: {
  kind: AssetToolbarKind;
  // 图片素材可用的编辑模型
  models: CanvasModelOption[];
  selectedModel: CanvasModelOption | null;
  onSelectModel: (model: CanvasModelOption) => void;
  onAction: (action: AssetToolbarAction, tier?: "2K" | "4K", frame?: "first" | "last" | "custom") => void;
}) {
  const t = useTranslations("canvas.assetToolbar");
  const [upscaleOpen, setUpscaleOpen] = React.useState(false);

  return (
    <div
      data-canvas-ui="asset-toolbar"
      className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1 overflow-x-auto rounded-2xl border border-border/60 bg-background/95 p-1.5 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
    >
      {kind === "image" ? (
        <>
          <CanvasModelSelect
            models={models}
            selectedModel={selectedModel}
            onSelect={onSelectModel}
            className="h-8 min-w-[9rem] max-w-[13rem] rounded-lg border-border/60"
          />
          <span className="mx-0.5 h-5 w-px shrink-0 bg-border/70" />
          <ToolbarAction
            icon={<Paintbrush className="size-3.5" strokeWidth={1.8} />}
            label={t("inpaint")}
            onClick={() => onAction("inpaint")}
          />
          <ToolbarAction
            icon={<Expand className="size-3.5" strokeWidth={1.8} />}
            label={t("outpaint")}
            onClick={() => onAction("outpaint")}
          />
          <ToolbarAction
            icon={<Crop className="size-3.5" strokeWidth={1.8} />}
            label={t("crop")}
            onClick={() => onAction("crop")}
          />
          <Popover open={upscaleOpen} onOpenChange={setUpscaleOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                title={t("upscale")}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Sparkles className="size-3.5" strokeWidth={1.8} />
                <span className="whitespace-nowrap">{t("upscale")}</span>
                <ChevronDown className="size-3 text-muted-foreground" strokeWidth={2} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" sideOffset={10} className="w-36 p-1.5">
              <div className="grid grid-cols-2 gap-1">
                {(["2K", "4K"] as const).map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    className="rounded-lg bg-muted/60 py-2 text-[11px] font-medium tabular-nums transition-colors hover:bg-accent"
                    onClick={() => {
                      setUpscaleOpen(false);
                      onAction("upscale", tier);
                    }}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </>
      ) : null}

      {kind === "video" ? (
        <>
          <span className="ml-1 inline-flex shrink-0 items-center gap-1 pl-1.5 pr-0.5 text-[11px] text-muted-foreground">
            <ImageIcon className="size-3.5" strokeWidth={1.8} />
            {t("extractFrame")}
          </span>
          {([
            { key: "first", label: t("frameFirst") },
            { key: "last", label: t("frameLast") },
            { key: "custom", label: t("frameCustom") },
          ] as const).map((option) => (
            <ToolbarAction
              key={option.key}
              label={option.label}
              onClick={() => onAction("extractFrame", undefined, option.key)}
            />
          ))}
          <span className="mx-0.5 h-5 w-px shrink-0 bg-border/70" />
          <ToolbarAction
            icon={<AudioLines className="size-3.5" strokeWidth={1.8} />}
            label={t("extractAudio")}
            onClick={() => onAction("extractAudio")}
          />
        </>
      ) : null}

      {kind === "audio" ? (
        <span className="px-2 text-[11px] text-muted-foreground">{t("audioHint")}</span>
      ) : null}

      <ToolbarAction
        icon={<Trash2 className="size-3.5" strokeWidth={1.8} />}
        label={t("remove")}
        onClick={() => onAction("remove")}
        destructive
      />
    </div>
  );
}
