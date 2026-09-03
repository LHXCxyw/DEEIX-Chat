"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, ImagePlus, X } from "lucide-react";

import { toast } from "sonner";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import type { CanvasReferenceImage } from "@/features/canvas/hooks/use-canvas-store";
import { CanvasImageParams } from "@/features/canvas/components/canvas-image-params";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import { resolveCanvasRoute } from "@/features/canvas/model/canvas-image-options";
import type { ConversationOptions } from "@/shared/api/conversation.types";
import { cn } from "@/lib/utils";

export function CanvasPromptBar({
  prompt,
  onPromptChange,
  references,
  onReferencesChange,
  onGenerate,
  onAttachFile,
  uploadingReference,
  imageModels,
  selectedModel,
  onSelectModel,
  imageOptions,
  onImageOptionsChange,
  onOverlayOpenChange,
}: {
  prompt: string;
  onPromptChange: (value: string) => void;
  references: CanvasReferenceImage[];
  onReferencesChange: (references: CanvasReferenceImage[]) => void;
  onGenerate: (prompt: string, references: CanvasReferenceImage[], resultCount: number) => void;
  onAttachFile: (file: File) => void;
  uploadingReference: boolean;
  imageModels: ChatModelOption[];
  selectedModel: ChatModelOption | null;
  onSelectModel: (platformModelName: string) => void;
  imageOptions: ConversationOptions;
  onImageOptionsChange: (options: ConversationOptions) => void;
  onOverlayOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("canvas");
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [resultCount, setResultCount] = React.useState(1);

  // 自动增高
  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [prompt]);

  // 路由校验：仅支持图像编辑的模型禁止纯文本发送
  const routeDecision = React.useMemo(
    () => resolveCanvasRoute(selectedModel, references.length > 0),
    [references.length, selectedModel],
  );
  const blockedMessage = routeDecision.blockedReason
    ? routeDecision.blockedReason === "edit_reference_required"
      ? t("editReferenceRequired")
      : routeDecision.blockedReason === "edit_unsupported"
        ? t("editUnsupported")
        : routeDecision.blockedReason === "chat_capability_required"
          ? t("chatCapabilityRequired")
          : t("generationUnsupported")
    : "";

  const canGenerate =
    prompt.trim().length > 0 &&
    Boolean(selectedModel) &&
    !uploadingReference &&
    !routeDecision.blockedReason;

  const submit = React.useCallback(() => {
    if (blockedMessage) {
      toast.error(blockedMessage);
      return;
    }
    if (!canGenerate) {
      return;
    }
    onGenerate(prompt, references, resultCount);
    onPromptChange("");
    onReferencesChange([]);
    textareaRef.current?.focus();
  }, [blockedMessage, canGenerate, onGenerate, onPromptChange, onReferencesChange, prompt, references, resultCount]);

  return (
    <div
      data-canvas-ui="prompt-bar"
      className="pointer-events-auto mx-auto w-full max-w-3xl px-2 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:px-3 md:px-0"
    >
      {/* 参考图预览 */}
      {references.length > 0 ? (
        <div className="mb-2 flex max-w-full gap-1.5 overflow-x-auto rounded-xl border border-border bg-background/90 p-1.5 shadow-sm backdrop-blur-md">
          {references.map((reference) => (
            <div key={reference.fileID} className="flex shrink-0 items-center gap-2 rounded-lg bg-muted/40 p-1 pr-1.5">
              <div className="relative size-9 overflow-hidden rounded-md bg-muted/60">
                {reference.previewURL ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt={reference.fileName} className="size-full object-cover" draggable={false} src={reference.previewURL} />
                ) : null}
              </div>
              <span className="max-w-28 truncate text-[11px] text-muted-foreground">{reference.fileName}</span>
              <button
                type="button"
                aria-label={t("removeReference")}
                className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => onReferencesChange(references.filter((item) => item.fileID !== reference.fileID))}
              >
                <X className="size-3.5" strokeWidth={1.8} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 rounded-2xl border border-border bg-background/90 p-1.5 shadow-xl shadow-black/5 backdrop-blur-xl sm:gap-2 sm:p-2">
        <textarea
          ref={textareaRef}
          value={prompt}
          rows={1}
          name="canvas-prompt"
          aria-label={t("promptPlaceholder")}
          autoComplete="off"
          placeholder={t("promptPlaceholder")}
          className="max-h-40 min-h-8 w-full resize-none bg-transparent px-1 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => onPromptChange(event.target.value)}
          onPaste={(event) => {
            const imageFiles = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .flatMap((item) => {
                const file = item.getAsFile();
                return file ? [file] : [];
              });
            if (imageFiles.length === 0) {
              return;
            }
            const hasText = event.clipboardData.getData("text/plain").length > 0;
            if (!hasText) {
              event.preventDefault();
            }
            for (const file of imageFiles) {
              onAttachFile(file);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="flex items-center gap-1.5">
          <CanvasModelSelect
            imageModels={imageModels}
            selectedModel={selectedModel}
            onSelect={onSelectModel}
            onOpenChange={onOverlayOpenChange}
            disabled={uploadingReference}
          />
          {/* 图像参数集中在单个按钮内，避免底栏拥挤 */}
          <CanvasImageParams
            model={selectedModel}
            options={imageOptions}
            onOptionsChange={onImageOptionsChange}
            resultCount={resultCount}
            onResultCountChange={setResultCount}
            onOpenChange={onOverlayOpenChange}
            disabled={uploadingReference}
          />

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  onAttachFile(file);
                }
              }}
            />
            <button
              type="button"
              aria-label={t("attachReference")}
              title={t("attachReference")}
              disabled={uploadingReference}
              className="flex size-10 touch-manipulation items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 sm:size-8"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="size-4" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              aria-label={t("generate")}
              title={blockedMessage || t("generate")}
              disabled={!canGenerate && !blockedMessage}
              className={cn(
                "flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-[transform,filter,opacity] sm:size-8",
                "hover:brightness-110 active:scale-95",
                "disabled:pointer-events-none disabled:opacity-40",
                blockedMessage && "opacity-50",
              )}
              onClick={submit}
            >
              {uploadingReference ? (
                <span className="size-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
              ) : (
                <ArrowUp className="size-4" strokeWidth={2.2} />
              )}
            </button>
          </div>
        </div>
      </div>
      <p className="mt-1.5 hidden text-center text-[11px] text-muted-foreground/60 sm:block">
        {blockedMessage || t("promptHint")}
      </p>
    </div>
  );
}
