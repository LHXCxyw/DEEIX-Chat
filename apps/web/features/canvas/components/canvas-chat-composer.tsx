"use client";

import { ArrowUp, ImagePlus, LayoutList, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import {
  canvasModelKey,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import type { GraphNode } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 对话输入条：叠加在无限画布底部。画布的拖动/捏合缩放/节点交互保持原样，
// 任务经此创建后结果作为输出节点直接出现在画布上。
// 与桌面节点图共用同一 store 与生成管线，来回切换不丢数据。

export type ChatTaskInput = {
  prompt: string;
  referenceFiles: File[];
  model: CanvasModelOption;
  // 是否附带画布上下文（开关打开时由工作区拼到提示词前缀）
  includeCanvasContext: boolean;
};

export function CanvasChatComposer({
  imageModels,
  restoredModelKey,
  generatingCount,
  nodes,
  canvasContextEnabled,
  onCanvasContextToggle,
  onAddTask,
}: {
  imageModels: CanvasModelOption[];
  // 上次选中的模型身份键（区分接口重名模型；兼容旧版纯名称值）
  restoredModelKey: string | null;
  generatingCount: number;
  // 画布节点：用于附加上下文提示条的节点计数
  nodes: GraphNode[];
  // 是否附带画布上下文（状态由父组件持有）及其开关回调
  canvasContextEnabled: boolean;
  onCanvasContextToggle: (next: boolean) => void;
  onAddTask: (input: ChatTaskInput) => void;
}) {
  const t = useTranslations("canvas");
  const [prompt, setPrompt] = React.useState("");
  const [pendingFiles, setPendingFiles] = React.useState<{ id: string; file: File; previewURL: string }[]>([]);
  const [selectedModelKey, setSelectedModelKey] = React.useState<string>("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const selectedModel = React.useMemo(() => {
    return (
      imageModels.find((item) => canvasModelKey(item) === selectedModelKey)
      ?? imageModels.find((item) => canvasModelKey(item) === restoredModelKey)
      ?? imageModels.find((item) => item.platformModelName === restoredModelKey)
      ?? imageModels[0]
      ?? null
    );
  }, [imageModels, restoredModelKey, selectedModelKey]);
  // 视频模型必须携带提示词（上游 prompt 必填）
  const isVideoModel = selectedModel?.kinds.includes("video_gen") ?? false;

  // 初始模型到位后回填默认选择
  React.useEffect(() => {
    if (!selectedModelKey && imageModels.length > 0) {
      setSelectedModelKey(
        (restoredModelKey && imageModels.some((item) => canvasModelKey(item) === restoredModelKey)
          ? restoredModelKey
          : canvasModelKey(imageModels[0])),
      );
    }
  }, [imageModels, restoredModelKey, selectedModelKey]);

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

  const canSend = Boolean(prompt.trim() || (pendingFiles.length > 0 && !isVideoModel)) && Boolean(selectedModel);

  const send = React.useCallback(() => {
    if (!canSend || !selectedModel) {
      return;
    }
    onAddTask({
      prompt: prompt.trim(),
      referenceFiles: pendingFiles.map((item) => item.file),
      model: selectedModel,
      includeCanvasContext: canvasContextEnabled,
    });
    for (const item of pendingFiles) {
      URL.revokeObjectURL(item.previewURL);
    }
    setPendingFiles([]);
    setPrompt("");
  }, [canSend, canvasContextEnabled, onAddTask, pendingFiles, prompt, selectedModel]);
  return (
    <div
      data-canvas-ui="chat-composer"
      className="pointer-events-auto absolute bottom-3 left-3 right-3 z-20 mx-auto max-w-xl rounded-2xl border border-border/70 bg-background/90 p-2.5 shadow-lg backdrop-blur-xl"
    >
      {/* 附带画布上下文提示条：开关打开时展示节点数量，可一键移除 */}
      {canvasContextEnabled ? (
        <div className="mb-2 flex items-center">
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
            <LayoutList className="size-3 shrink-0" strokeWidth={1.8} />
            <span className="truncate">{t("canvasContextEnabled", { count: nodes.length })}</span>
            <button
              type="button"
              aria-label={t("attachCanvasContext")}
              title={t("attachCanvasContext")}
              className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-primary/15"
              onClick={() => onCanvasContextToggle(false)}
            >
              <X className="size-3" strokeWidth={1.8} />
            </button>
          </span>
        </div>
      ) : null}
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
        <button
          type="button"
          aria-label={t("attachCanvasContext")}
          title={t("attachCanvasContextHint")}
          aria-pressed={canvasContextEnabled}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            canvasContextEnabled && "bg-primary/10 text-primary ring-1 ring-primary/30 transition-colors",
          )}
          onClick={() => onCanvasContextToggle(!canvasContextEnabled)}
        >
          <LayoutList className="size-4" strokeWidth={1.8} />
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
          placeholder={isVideoModel ? t("videoPromptPlaceholder") : t("promptPlaceholder")}
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
          models={imageModels}
          selectedModel={selectedModel}
          onSelect={(model) => setSelectedModelKey(canvasModelKey(model))}
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
