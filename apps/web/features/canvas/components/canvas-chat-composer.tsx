"use client";

import { ArrowUp, ImagePlus, LayoutList, Loader2, Maximize2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { CanvasImageParams } from "@/features/canvas/components/canvas-image-params";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import {
  canvasModelKey,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import type { GraphNode } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";
import type { ConversationOptions } from "@/shared/api/conversation-types";

// 对话输入条：叠加在无限画布底部。画布的拖动/捏合缩放/节点交互保持原样，
// 任务经此创建后结果作为输出节点直接出现在画布上。
// 与桌面节点图共用同一 store 与生成管线，来回切换不丢数据。

export type ChatTaskInput = {
  prompt: string;
  referenceFiles: File[];
  model: CanvasModelOption;
  // 模型参数与生成数量：与节点图内的生成节点共用同一套参数面板
  options: ConversationOptions;
  resultCount: number;
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
  // 模型参数与生成数量：对话模式与节点图共用同一套参数语义
  const [options, setOptions] = React.useState<ConversationOptions>({});
  const [resultCount, setResultCount] = React.useState(1);
  // 放大输入：仅把提示词框铺满一屏便于写长提示词，不引入其它编辑能力
  const [expanded, setExpanded] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const expandedInputRef = React.useRef<HTMLTextAreaElement | null>(null);

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
      options,
      resultCount,
      includeCanvasContext: canvasContextEnabled,
    });
    for (const item of pendingFiles) {
      URL.revokeObjectURL(item.previewURL);
    }
    setPendingFiles([]);
    setPrompt("");
  }, [canSend, canvasContextEnabled, onAddTask, options, pendingFiles, prompt, resultCount, selectedModel]);

  // 桌面（精确指针）Enter 发送、Shift+Enter 换行；触屏保留 Enter 换行
  const handlePromptKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey && window.matchMedia("(pointer: fine)").matches) {
        event.preventDefault();
        send();
        setExpanded(false);
      }
    },
    [send],
  );

  // 放大输入打开时聚焦大框并支持 Esc 退出
  React.useEffect(() => {
    if (!expanded) {
      return;
    }
    expandedInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

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
      <div className="relative">
        <textarea
          aria-label={t("promptPlaceholder")}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handlePromptKeyDown}
          placeholder={isVideoModel ? t("videoPromptPlaceholder") : t("promptPlaceholder")}
          rows={1}
          className="max-h-32 min-h-9 w-full resize-none rounded-xl border border-border/70 bg-background/80 px-3 py-2 pr-9 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
        />
        <button
          type="button"
          aria-label={t("promptExpandOpen")}
          title={t("promptExpandOpen")}
          className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
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
        {/* 模型参数：紧凑图标按钮，已设参数时带角标 */}
        <CanvasImageParams
          model={selectedModel}
          mediaType={isVideoModel ? "video" : "image"}
          options={options}
          onOptionsChange={setOptions}
          resultCount={resultCount}
          onResultCountChange={setResultCount}
          iconOnly
        />
        <div className="min-w-0 flex-1">
          <CanvasModelSelect
            models={imageModels}
            selectedModel={selectedModel}
            onSelect={(model) => setSelectedModelKey(canvasModelKey(model))}
            className="h-8 w-full justify-between"
          />
        </div>
        {generatingCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            <Loader2 className="size-3 animate-spin" />
            {t("generatingCount", { count: generatingCount })}
          </span>
        ) : null}
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
      {/* 放大输入：把提示词框铺满一屏，Esc / 关闭按钮退出，其余行为与输入条一致 */}
      {expanded ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("promptExpandTitle")}
          className="fixed inset-0 z-50 flex flex-col gap-3 bg-background/95 p-4 backdrop-blur-md motion-reduce:backdrop-blur-none sm:p-8"
        >
          <div className="flex shrink-0 items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">{t("promptExpandTitle")}</span>
            <button
              type="button"
              aria-label={t("promptExpandClose")}
              title={t("promptExpandClose")}
              className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background/90 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setExpanded(false)}
            >
              <X className="size-4" strokeWidth={1.8} />
            </button>
          </div>
          <textarea
            ref={expandedInputRef}
            aria-label={isVideoModel ? t("videoPromptPlaceholder") : t("promptPlaceholder")}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder={isVideoModel ? t("videoPromptPlaceholder") : t("promptPlaceholder")}
            className="min-h-0 w-full flex-1 resize-none rounded-xl border border-border/70 bg-background/80 px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
          />
          <div className="flex shrink-0 justify-end">
            <button
              type="button"
              disabled={!canSend}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-xl px-4 text-xs font-semibold text-primary-foreground shadow-sm transition-all active:scale-95",
                canSend ? "bg-primary hover:bg-primary/90" : "bg-muted text-muted-foreground/60",
              )}
              onClick={() => {
                send();
                setExpanded(false);
              }}
            >
              <ArrowUp className="size-4" strokeWidth={2} />
              {t("generate")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
