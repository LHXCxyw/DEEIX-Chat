import * as React from "react";
import { Check, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { MODEL_KIND_OPTIONS } from "@/features/admin/types/llm";
import { PROTOCOL_PRESETS } from "@/shared/lib/llm-presets";

const TRIGGER_CLASSNAME =
  "h-8 min-w-0 w-full justify-between gap-2 border-input/40 bg-transparent px-3 py-1 text-xs font-normal text-muted-foreground shadow-none hover:bg-transparent focus-visible:border-ring/60 focus-visible:ring-[1px] focus-visible:ring-ring/40 has-[>svg]:px-3";

const KIND_LABELS: Record<string, string> = {
  chat: "对话",
  image_gen: "图像生成",
  image_edit: "图像编辑",
  video_gen: "视频生成",
  video_extension: "视频延展",
};

function resolveKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** 模型能力多选下拉，值为逗号分隔的能力标识 */
export function UserKindsDropdown({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const selectedKinds = React.useMemo(
    () => value.split(",").map((item) => item.trim()).filter(Boolean),
    [value],
  );
  const selectedLabel = selectedKinds.map(resolveKindLabel).join(", ");

  function toggle(kind: string) {
    const next = new Set(selectedKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    if (next.size === 0) next.add("chat");
    onChange(Array.from(next).join(","));
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          disabled={disabled}
          className={cn(TRIGGER_CLASSNAME, className)}
        >
          <span className={cn("min-w-0 flex-1 truncate text-left", selectedLabel ? "text-foreground/75" : "")}>
            {selectedLabel || "选择能力"}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {MODEL_KIND_OPTIONS.map(({ value: kind }) => (
          <button
            key={kind}
            type="button"
            onClick={() => toggle(kind)}
            className="relative flex w-full items-center rounded-sm py-1.5 pr-8 pl-2 text-xs font-normal hover:bg-accent"
          >
            <span className="min-w-0 flex-1 truncate text-left">{resolveKindLabel(kind)}</span>
            <Check
              className={cn(
                "absolute right-2 size-4 shrink-0 text-muted-foreground",
                selectedKinds.includes(kind) ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** 调用协议单选下拉，用户模型每条路由只对应一个协议 */
export function UserProtocolDropdown({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selectedLabel = PROTOCOL_PRESETS.find((item) => item.value === value)?.label ?? "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          disabled={disabled}
          className={cn(TRIGGER_CLASSNAME, className)}
        >
          <span className={cn("min-w-0 flex-1 truncate text-left", selectedLabel ? "text-foreground/75" : "")}>
            {selectedLabel || "选择协议"}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        {PROTOCOL_PRESETS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => {
              onChange(item.value);
              setOpen(false);
            }}
            className="relative flex w-full items-center rounded-sm py-1.5 pr-8 pl-2 text-xs font-normal hover:bg-accent"
          >
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            <Check
              className={cn(
                "absolute right-2 size-4 shrink-0 text-muted-foreground",
                value === item.value ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
