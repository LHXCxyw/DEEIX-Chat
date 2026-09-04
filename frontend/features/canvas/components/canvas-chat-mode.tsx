"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowUp,
  Download,
  ImagePlus,
  Images,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from "lucide-react";

import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import {
  type GenerateGraphNode,
  type GraphEdge,
  type GraphNode,
  type OutputGraphNode,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 移动端对话模式：同一画布数据的对话式视图。
// 生成节点渲染为一条任务消息，连线上的输出节点作为结果气泡，
// 底部输入条负责创建任务（提示词节点 + 参考图节点 + 生成节点并自动连线），
// 与桌面节点图共用同一 store 与生成管线，来回切换不丢数据。

export type ChatTaskInput = {
  prompt: string;
  referenceFiles: File[];
  model: ChatModelOption;
};

type ChatTask = {
  generate: GenerateGraphNode | null;
  promptText: string;
  references: { fileID: string; fileName: string; previewURL?: string }[];
  outputs: OutputGraphNode[];
};

function buildChatTasks(nodes: GraphNode[], edges: GraphEdge[]): ChatTask[] {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const orderedEdges = [...edges].sort((a, b) => a.createdAt - b.createdAt);

  const tasks = new Map<string, ChatTask>();
  const orphanOutputs: OutputGraphNode[] = [];
  const coveredOutputIDs = new Set<string>();

  for (const node of nodes) {
    if (node.kind === "generate") {
      tasks.set(node.id, { generate: node, promptText: "", references: [], outputs: [] });
    }
  }

  for (const edge of orderedEdges) {
    const from = nodeByID.get(edge.fromNodeID);
    const to = nodeByID.get(edge.toNodeID);
    if (!from || !to) {
      continue;
    }
    // 生成 -> 输出：结果气泡
    if (from.kind === "generate" && to.kind === "output" && edge.toPort === "result") {
      const task = tasks.get(from.id);
      if (task) {
        task.outputs.push(to);
        coveredOutputIDs.add(to.id);
      }
      continue;
    }
    if (to.kind !== "generate") {
      continue;
    }
    const task = tasks.get(to.id);
    if (!task) {
      continue;
    }
    if (edge.toPort === "prompt" && from.kind === "prompt" && from.text.trim()) {
      task.promptText = task.promptText
        ? `${task.promptText}\n\n${from.text.trim()}`
        : from.text.trim();
    }
    if (edge.toPort === "image") {
      if (from.kind === "image" && from.reference) {
        task.references.push({
          fileID: from.reference.fileID,
          fileName: from.reference.fileName,
          previewURL: from.previewURL,
        });
      }
      if (from.kind === "output" && from.status === "done" && from.fileID) {
        task.references.push({
          fileID: from.fileID,
          fileName: from.fileName ?? "image.png",
          previewURL: from.objectURL,
        });
      }
    }
  }

  // 没有连到任何生成节点的输出节点（如旧数据迁移结果）单独成组
  for (const node of nodes) {
    if (node.kind === "output" && !coveredOutputIDs.has(node.id)) {
      orphanOutputs.push(node);
    }
  }

  const list = [...tasks.values()].sort((a, b) =>
    (a.generate?.createdAt ?? 0) - (b.generate?.createdAt ?? 0));
  if (orphanOutputs.length > 0) {
    list.push({ generate: null, promptText: "", references: [], outputs: orphanOutputs });
  }
  return list;
}

export function CanvasChatMode({
  nodes,
  edges,
  imageModels,
  restoredModelName,
  generatingCount,
  onRunNode,
  onCancelNode,
  onPreviewNode,
  onDownloadNode,
  onEditNode,
  onUseAsReference,
  onAddTask,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  imageModels: ChatModelOption[];
  restoredModelName: string | null;
  generatingCount: number;
  onRunNode: (nodeID: string) => void;
  onCancelNode: (nodeID: string) => void;
  onPreviewNode: (node: OutputGraphNode) => void;
  onDownloadNode: (node: OutputGraphNode) => void;
  onEditNode: (node: OutputGraphNode) => void;
  onUseAsReference: (node: OutputGraphNode) => void;
  onAddTask: (input: ChatTaskInput) => void;
}) {
  const t = useTranslations("canvas");
  const [prompt, setPrompt] = React.useState("");
  const [pendingFiles, setPendingFiles] = React.useState<{ id: string; file: File; previewURL: string }[]>([]);
  const [selectedModelName, setSelectedModelName] = React.useState<string>("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const listEndRef = React.useRef<HTMLDivElement | null>(null);

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

  const tasks = React.useMemo(() => buildChatTasks(nodes, edges), [nodes, edges]);
  const isEmpty = tasks.length === 0 && nodes.length === 0;

  // 新结果出现时滚动到列表底部
  const outputSignature = tasks.map((task) => task.outputs.map((output) => output.id).join(",")).join("|");
  React.useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [outputSignature]);

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
    <div className="flex h-full flex-col bg-background/30">
      {/* 任务消息流 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-3">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-background/70 shadow-sm backdrop-blur-xl">
              <Sparkles className="size-6 text-primary/80" strokeWidth={1.5} />
            </span>
            <p className="text-base font-semibold tracking-tight text-foreground/90">{t("chatEmptyTitle")}</p>
            <p className="max-w-72 text-xs leading-relaxed text-muted-foreground/70">{t("chatEmptyHint")}</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
            {tasks.map((task, index) => (
              <ChatTaskCard
                key={task.generate?.id ?? `orphan-${index}`}
                task={task}
                imageModels={imageModels}
                onRunNode={onRunNode}
                onCancelNode={onCancelNode}
                onPreviewNode={onPreviewNode}
                onDownloadNode={onDownloadNode}
                onEditNode={onEditNode}
                onUseAsReference={onUseAsReference}
              />
            ))}
            <div ref={listEndRef} />
          </div>
        )}
      </div>

      {/* 底部输入条 */}
      <div className="shrink-0 border-t border-border/60 bg-background/85 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-2xl">
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
              className="h-8 max-w-[16rem] flex-1"
            />
            {generatingCount > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                <Loader2 className="size-3 animate-spin" />
                {t("generatingCount", { count: generatingCount })}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// 单条任务消息：状态头 + 提示词 + 参考图行 + 结果气泡
function ChatTaskCard({
  task,
  imageModels,
  onRunNode,
  onCancelNode,
  onPreviewNode,
  onDownloadNode,
  onEditNode,
  onUseAsReference,
}: {
  task: ChatTask;
  imageModels: ChatModelOption[];
  onRunNode: (nodeID: string) => void;
  onCancelNode: (nodeID: string) => void;
  onPreviewNode: (node: OutputGraphNode) => void;
  onDownloadNode: (node: OutputGraphNode) => void;
  onEditNode: (node: OutputGraphNode) => void;
  onUseAsReference: (node: OutputGraphNode) => void;
}) {
  const t = useTranslations("canvas");
  const generate = task.generate;
  const running = generate ? generate.runStatus === "pending" || generate.runStatus === "streaming" : false;
  const model = generate
    ? imageModels.find((item) => item.platformModelName === generate.model) ?? null
    : null;
  const modelName = model?.platformModelName ?? generate?.model ?? "";
  const failed = Boolean(generate?.errorMessage);

  return (
    <section className="rounded-2xl border border-border/70 bg-background/90 p-3 shadow-sm backdrop-blur-xl">
      {/* 任务头：模型 + 状态 + 操作 */}
      {generate ? (
        <div className="mb-2 flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <Sparkles className="size-3.5" strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground/85" title={modelName}>
            {modelName || t("modelSelectPlaceholder")}
          </span>
          {running ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <Loader2 className="size-3 animate-spin" />
              {generate.statusLabel || t("nodePreparing")}
            </span>
          ) : failed ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
              <AlertTriangle className="size-3" />
              {t("filterError")}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={running ? t("nodeCancel") : t("regenerateAction")}
            title={running ? t("nodeCancel") : t("regenerateAction")}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => (running ? onCancelNode(generate.id) : onRunNode(generate.id))}
          >
            {running ? <Square className="size-3.5" /> : <RefreshCw className="size-3.5" strokeWidth={1.8} />}
          </button>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Images className="size-3.5" strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground/85">{t("nodeKindOutput")}</span>
        </div>
      )}

      {/* 提示词 */}
      {task.promptText ? (
        <p className="mb-2 whitespace-pre-wrap break-words rounded-xl bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-foreground/85">
          {task.promptText}
        </p>
      ) : null}

      {/* 参考图行 */}
      {task.references.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {task.references.map((reference) => (
            <span
              key={reference.fileID}
              title={reference.fileName}
              className="size-12 overflow-hidden rounded-lg border border-border/60 bg-muted/40"
            >
              {reference.previewURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={reference.previewURL} alt={reference.fileName} className="size-full object-cover" draggable={false} />
              ) : (
                <span className="flex size-full items-center justify-center">
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                </span>
              )}
            </span>
          ))}
        </div>
      ) : null}

      {/* 错误信息 */}
      {generate?.errorMessage ? (
        <p className="mb-2 break-words rounded-xl bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
          {generate.errorMessage}
        </p>
      ) : null}

      {/* 结果气泡 */}
      {task.outputs.length > 0 ? (
        <div className={cn("grid gap-2", task.outputs.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
          {task.outputs.map((output) => (
            <ChatResultBubble
              key={output.id}
              output={output}
              running={running}
              onPreviewNode={onPreviewNode}
              onDownloadNode={onDownloadNode}
              onEditNode={onEditNode}
              onUseAsReference={onUseAsReference}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// 结果气泡：完成可预览/下载/编辑/用作参考，其余显示状态占位
function ChatResultBubble({
  output,
  running,
  onPreviewNode,
  onDownloadNode,
  onEditNode,
  onUseAsReference,
}: {
  output: OutputGraphNode;
  running: boolean;
  onPreviewNode: (node: OutputGraphNode) => void;
  onDownloadNode: (node: OutputGraphNode) => void;
  onEditNode: (node: OutputGraphNode) => void;
  onUseAsReference: (node: OutputGraphNode) => void;
}) {
  const t = useTranslations("canvas");
  const done = output.status === "done" && output.objectURL;

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/25">
      {done ? (
        <>
          <button
            type="button"
            aria-label={t("nodePreviewHint")}
            className="block w-full cursor-zoom-in"
            onClick={() => onPreviewNode(output)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={output.objectURL} alt={output.prompt || output.fileName || "output"} className="h-auto max-h-80 w-full object-contain" draggable={false} />
          </button>
          <div className="flex items-center gap-1 border-t border-border/50 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={output.model}>
              {output.model}
            </span>
            <button
              type="button"
              aria-label={t("nodeDownload")}
              title={t("nodeDownload")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onDownloadNode(output)}
            >
              <Download className="size-3.5" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              aria-label={t("nodeUseAsReference")}
              title={t("nodeUseAsReference")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onUseAsReference(output)}
            >
              <ImagePlus className="size-3.5" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              aria-label={t("nodeEdit")}
              title={t("nodeEdit")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onEditNode(output)}
            >
              <Sparkles className="size-3.5" strokeWidth={1.8} />
            </button>
          </div>
        </>
      ) : output.status === "error" ? (
        <div className="flex flex-col items-center justify-center gap-1.5 p-4 text-center">
          <AlertTriangle className="size-4 text-destructive/80" strokeWidth={1.6} />
          <p className="break-words text-[11px] leading-relaxed text-muted-foreground">
            {output.errorMessage || t("generateFailed")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1.5 p-6 text-muted-foreground">
          {running ? (
            <>
              <span className="size-5 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
              <p className="text-[11px]">{t("filterStreaming")}</p>
            </>
          ) : output.imageLoadFailed ? (
            <>
              <AlertTriangle className="size-4" strokeWidth={1.6} />
              <p className="text-[11px]">{t("nodeImageLoadFailed")}</p>
            </>
          ) : (
            <>
              <Images className="size-4" strokeWidth={1.6} />
              <p className="text-[11px]">{t("outputNodeEmptyHint")}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
