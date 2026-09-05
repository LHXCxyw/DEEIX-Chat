"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, ImagePlus, Loader2, X } from "lucide-react";

import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import { cn } from "@/lib/utils";

// 移动端对话输入条：叠加在无限画布底部（lg 以下显示）。
// 画布的拖动/捏合缩放/节点交互保持原样，任务经此创建后结果作为输出节点直接出现在画布上。
// 与桌面节点图共用同一 store 与生成管线，来回切换不丢数据。

export type ChatTaskInput = {
  prompt: string;
  referenceFiles: File[];
  model: ChatModelOption;
};

export function CanvasChatComposer({
  imageModels,
  restoredModelName,
  generatingCount,
  onAddTask,
}: {
  imageModels: ChatModelOption[];
  restoredModelName: string | null;
  generatingCount: number;
  onAddTask: (input: ChatTaskInput) => void;
}) {
  const t = useTranslations("canvas");
  const [prompt, setPrompt] = React.useState("");
  const [pendingFiles, setPendingFiles] = React.useState<{ id: string; file: File; previewURL: string }[]>([]);
  const [selectedModelName, setSelectedModelName] = React.useState<string>("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const selectedModel = React.useMemo(() => {
    const byName = imageModels.find((item) => item.platformModelName === selectedModelName)
      ?? imageModels.find((item) => item.platformModelName === restoredModelName);
    return byName ?? imageModels[0] ?? null;
  }, [imageModels, restoredModelName, selectedModelName]);

  // 初始模型到位后回填默认选择
  React.useEffect(() => {
    if (!selectedModelName && imageModels.length > 0) {
      setSelectedModelName(
        (restoredModelName && imageModels.some((item) => item.platformModelName === restoredModelName)
          ? restoredModelName
          : imageModels[0].platformModelName),
      );
    }
  }, [imageModels, restoredModelName, selectedModelName]);

  const addFiles = React.useCallback((files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      return;
    }
    setPendingFiles((current) => [
      ...current,
      ...images.map((file) => ({
        id: `${file.name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        file,
        previewURL: URL.createObjectURL(file),
      })),
    ]);
  }, []);

  const removePendingFile = React.useCallback((id: string) => {
    setPendingFiles((current) => {
      for (const item of current) {
        if (item.id === id) {
          URL.revokeObjectURL(item.previewURL);
        }
      }
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const canSend = Boolean(prompt.trim() || pendingFiles.length > 0) && Boolean(selectedModel);

  const send = React.useCallback(() => {
    if (!canSend || !selectedModel) {
      return;
    }
    onAddTask({
      prompt: prompt.trim(),
      referenceFiles: pendingFiles.map((item) => item.file),
      model: selectedModel,
    });
    for (const item of pendingFiles) {
      URL.revokeObjectURL(item.previewURL);
    }
    setPendingFiles([]);
    setPrompt("");
  }, [canSend, onAddTask, pendingFiles, prompt, selectedModel]);

  return (
    <div
      data-canvas-ui="chat-composer"
      className="pointer-events-auto absolute bottom-3 left-3 right-3 z-20 mx-auto max-w-xl rounded-2xl border border-border/70 bg-background/90 p-2.5 shadow-lg backdrop-blur-xl"
    >
      {pendingFiles.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingFiles.map((item) => (
            <span key={item.id} className="relative size-14 overflow-hidden rounded-lg border border-border/60 bg-muted/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.previewURL} alt={item.file.name} className="size-full object-cover" draggable={false} />
              <button
                type="button"
                aria-label={t("removeReference")}
                className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-muted-foreground shadow-sm"
                onClick={() => removePendingFile(item.id)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-1.5">
        <button
          type="button"
          aria-label={t("attachReference")}
          title={t("attachReference")}
          className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus className="size-4" strokeWidth={1.8} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <textarea
          aria-label={t("promptPlaceholder")}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // 桌面（精确指针）Enter 发送、Shift+Enter 换行；触屏保留 Enter 换行
            if (event.key === "Enter" && !event.shiftKey && window.matchMedia("(pointer: fine)").matches) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={t("promptPlaceholder")}
          rows={1}
          className="max-h-32 min-h-9 flex-1 resize-none rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
        />
        <button
          type="button"
          aria-label={t("generate")}
          disabled={!canSend}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl text-primary-foreground shadow-sm transition-all active:scale-95",
            canSend ? "bg-primary hover:bg-primary/90" : "bg-muted text-muted-foreground/60",
          )}
          onClick={send}
        >
          <ArrowUp className="size-4" strokeWidth={2} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <CanvasModelSelect
          imageModels={imageModels}
          selectedModel={selectedModel}
          onSelect={setSelectedModelName}
          className="h-8 max-w-[14rem] flex-1"
        />
        {generatingCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            <Loader2 className="size-3 animate-spin" />
            {t("generatingCount", { count: generatingCount })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
