"use client";

import {
  ArrowUp,
  AudioLines,
  ImagePlus,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Video,
  Workflow,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { createPortal } from "react-dom";
import { CanvasImageParams } from "@/features/canvas/components/canvas-image-params";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import {
  canvasModelKey,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import type { GenerateGraphNode } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";
import type { ConversationOptions } from "@/shared/api/conversation-types";

// 对话输入条：叠加在无限画布底部。画布的拖动/捏合缩放/节点交互保持原样，
// 任务经此创建后结果作为输出节点直接出现在画布上。
// 与桌面节点图共用同一 store 与生成管线，来回切换不丢数据。

// 继承生成节点时展示的上游素材（可逐个移除，与原画布连线一一对应）
export type ChatInheritedAsset = {
  fileID: string;
  fileName: string;
  kind: "image" | "video" | "audio";
  // 素材来源节点与接入端口：移除继承时按此断开对应连线
  sourceNodeID: string;
  port: "image" | "video" | "audio";
};

// 选中的生成节点（或其输出节点所属的生成节点）：输入条继承其模型、参数与素材，
// 发送时直接在该生成节点上发起任务，不再新建一批节点
export type ChatInheritedContext = {
  node: GenerateGraphNode;
  prompt: string;
  assets: ChatInheritedAsset[];
};

export type ChatTaskInput = {
  prompt: string;
  referenceFiles: File[];
  model: CanvasModelOption;
  // 模型参数与生成数量：与节点图内的生成节点共用同一套参数面板
  options: ConversationOptions;
  resultCount: number;
  // 继承生成节点时携带目标任务节点 ID：发送后在该节点上直接发起生成
  inheritedGenerateNodeID?: string;
};

function assetIcon(kind: ChatInheritedAsset["kind"]): React.ReactNode {
  if (kind === "video") {
    return <Video className="size-3 shrink-0 text-fuchsia-500" strokeWidth={1.8} />;
  }
  if (kind === "audio") {
    return <AudioLines className="size-3 shrink-0 text-fuchsia-500" strokeWidth={1.8} />;
  }
  return <ImageIcon className="size-3 shrink-0 text-sky-500" strokeWidth={1.8} />;
}

export function CanvasChatComposer({
  imageModels,
  restoredModelKey,
  generatingCount,
  inherited,
  onClearInherited,
  onRemoveInheritedAsset,
  onAddTask,
}: {
  imageModels: CanvasModelOption[];
  // 上次选中的模型身份键（区分接口重名模型；兼容旧版纯名称值）
  restoredModelKey: string | null;
  generatingCount: number;
  // 画布中选中的生成节点：输入条继承其状态与素材
  inherited: ChatInheritedContext | null;
  onClearInherited: () => void;
  // 移除单个继承素材：断开该素材与生成节点的连线，不影响其他继承内容
  onRemoveInheritedAsset: (asset: ChatInheritedAsset) => void;
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
  const inheritedNodeID = inherited?.node.id ?? "";
  const lastInheritedIDRef = React.useRef("");

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

  // 继承切换：把生成节点的模型、参数、提示词同步到输入条（同一节点内编辑不回填）
  React.useEffect(() => {
    if (lastInheritedIDRef.current === inheritedNodeID) {
      return;
    }
    lastInheritedIDRef.current = inheritedNodeID;
    if (!inherited) {
      setPrompt("");
      return;
    }
    const node = inherited.node;
    const matched = imageModels.find((item) =>
      item.platformModelName === node.model
      && (node.modelScope === "user"
        ? item.modelScope === "user" && item.userModelID === node.userModelID
        : (item.modelScope ?? "platform") === (node.modelScope ?? "platform")))
      ?? imageModels.find((item) => item.platformModelName === node.model)
      ?? null;
    if (matched) {
      setSelectedModelKey(canvasModelKey(matched));
    }
    setOptions(node.options ?? {});
    setResultCount(node.resultCount ?? 1);
    setPrompt(inherited.prompt);
  }, [imageModels, inherited, inheritedNodeID]);

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

  // 继承模式下即使留空也能发送：沿用生成节点已连接的提示词与素材
  const canSend = Boolean(selectedModel) && (
    inherited
      ? Boolean(prompt.trim() || inherited.prompt.trim() || inherited.assets.length > 0)
      : Boolean(prompt.trim() || (pendingFiles.length > 0 && !isVideoModel))
  );

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
      inheritedGenerateNodeID: inherited?.node.id,
    });
    for (const item of pendingFiles) {
      URL.revokeObjectURL(item.previewURL);
    }
    setPendingFiles([]);
    // 继承模式下保留提示词：同一节点可连续发起多次生成
    if (!inherited) {
      setPrompt("");
    }
  }, [canSend, inherited, onAddTask, options, pendingFiles, prompt, resultCount, selectedModel]);

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

  const composer = (
    <div
      data-canvas-ui="chat-composer"
      className={cn(
        "pointer-events-auto rounded-2xl border border-border/70 bg-background/90 backdrop-blur-xl",
        expanded
          ? "fixed left-1/2 top-1/2 z-[81] max-h-[88dvh] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-3 shadow-2xl"
          : "absolute bottom-3 left-3 right-3 z-20 mx-auto max-w-xl p-2.5 shadow-lg",
      )}
    >
      {expanded ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">{t("promptExpandTitle")}</span>
          <button
            type="button"
            aria-label={t("promptExpandOpen")}
            title={t("promptExpandOpen")}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setExpanded(false)}
          >
            <X className="size-3.5" strokeWidth={1.8} />
          </button>
        </div>
      ) : null}
      {/* 继承提示条：选中的生成节点把模型、参数与素材带入输入条，可一键解除继承 */}
      {inherited ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
            <Workflow className="size-3 shrink-0" strokeWidth={1.8} />
            <span className="truncate">{t("inheritedNodeChip")}</span>
            <button
              type="button"
              aria-label={t("inheritedClear")}
              title={t("inheritedClear")}
              className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-primary/15"
              onClick={onClearInherited}
            >
              <X className="size-3" strokeWidth={1.8} />
            </button>
          </span>
          {inherited.assets.map((asset) => (
            <span
              key={`${asset.port}-${asset.fileID}`}
              title={asset.fileName}
              className="inline-flex max-w-48 items-center gap-1 rounded-full border border-border/60 bg-background/70 py-1 pl-2 pr-1 text-[10px] text-muted-foreground"
            >
              {assetIcon(asset.kind)}
              <span className="truncate">{asset.fileName}</span>
              <button
                type="button"
                aria-label={t("inheritedAssetRemove")}
                title={t("inheritedAssetRemove")}
                className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => onRemoveInheritedAsset(asset)}
              >
                <X className="size-2.5" strokeWidth={2} />
              </button>
            </span>
          ))}
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
          placeholder={
            inherited
              ? t("inheritedPromptPlaceholder")
              : isVideoModel ? t("videoPromptPlaceholder") : t("promptPlaceholder")
          }
          rows={expanded ? 8 : 1}
          className={cn(
            "w-full resize-none rounded-xl border border-border/70 bg-background/80 pr-9 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 focus:ring-1 focus:ring-primary/30",
            expanded ? "min-h-40 max-h-[46dvh] px-3 py-2" : "min-h-6 max-h-32 px-3 py-1",
          )}
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
    </div>
  );

  // 放大输入：整个对话框居中放大显示，背景只做轻遮罩，点击遮罩退出
  if (!expanded) {
    return composer;
  }
  return createPortal(
    <>
      <button
        type="button"
        data-canvas-ui="chat-composer-backdrop"
        aria-label={t("promptExpandClose")}
        className="fixed inset-0 z-[79] cursor-default bg-background/70 backdrop-blur-sm"
        onClick={() => setExpanded(false)}
      />
      {composer}
    </>,
    document.body,
  );
}
