"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronsUpDown, Check, Sparkles } from "lucide-react";

import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { modelSupportsImageEditRoute } from "@/features/canvas/model/canvas-image-options";
import { ModelIcon } from "@/shared/components/model-icon";
import { resolveModelIconURL, resolveModelIdentity } from "@/shared/lib/model-identity";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function CanvasModelSelect({
  imageModels,
  selectedModel,
  onSelect,
  onOpenChange,
  disabled,
  className,
}: {
  imageModels: ChatModelOption[];
  selectedModel: ChatModelOption | null;
  onSelect: (platformModelName: string) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("canvas");
  const [open, setOpen] = React.useState(false);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const selectedIdentity = React.useMemo(
    () =>
      selectedModel
        ? resolveModelIdentity({
            code: selectedModel.platformModelName,
            vendor: selectedModel.vendor,
            icon: selectedModel.icon,
          })
        : null,
    [selectedModel],
  );
  const selectedIconURL = selectedIdentity ? resolveModelIconURL(selectedIdentity.modelIcon) : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled || imageModels.length === 0}
        className={cn(
          "flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-accent hover:text-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
          "[&_svg]:shrink-0",
          className,
        )}
      >
        {selectedModel ? (
          <>
            <ModelIcon iconUrl={selectedIconURL} label={selectedModel.platformModelName} size={14} />
            <span className="max-w-40 truncate">{selectedModel.platformModelName}</span>
            {modelSupportsImageEditRoute(selectedModel) ? (
              <span className="hidden shrink-0 rounded-sm bg-primary/10 px-1 py-0.5 text-[10px] font-semibold text-primary sm:inline">
                {t("modelEditCapable")}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <Sparkles className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
            <span className="text-muted-foreground">{t("modelSelectPlaceholder")}</span>
          </>
        )}
        <ChevronsUpDown className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
      </PopoverTrigger>
      <PopoverContent data-canvas-ui="model-select" align="start" side="top" className="w-64 p-1.5">
        <div className="max-h-72 overflow-y-auto">
          {imageModels.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t("noImageModels")}
            </p>
          ) : (
            imageModels.map((model) => {
              const identity = resolveModelIdentity({
                code: model.platformModelName,
                vendor: model.vendor,
                icon: model.icon,
              });
              const iconURL = resolveModelIconURL(identity.modelIcon);
              const selected = selectedModel?.platformModelName === model.platformModelName;
              return (
                <button
                  key={`${model.modelScope ?? "platform"}:${model.platformModelName}`}
                  type="button"
                  data-selected={selected}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground data-[selected=true]:bg-accent/60"
                  onClick={() => {
                    onSelect(model.platformModelName);
                    setOpen(false);
                  }}
                >
                  <ModelIcon iconUrl={iconURL} label={model.platformModelName} size={15} />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {model.platformModelName}
                  </span>
                  {modelSupportsImageEditRoute(model) ? (
                    <span className="shrink-0 rounded-sm bg-primary/10 px-1 py-0.5 text-[10px] font-semibold text-primary">
                      {t("modelEditCapable")}
                    </span>
                  ) : null}
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    {selected ? <Check className="size-3.5" strokeWidth={1.8} /> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
