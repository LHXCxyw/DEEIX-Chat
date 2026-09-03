"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { RefreshCw, X } from "lucide-react";

import type { CanvasNode } from "@/features/canvas/model/canvas-types";

// 编辑提示词重新生成对话框：预填原图提示词，提交后基于原图参数派生新节点
export function CanvasRegenerateDialog({
  node,
  onClose,
  onSubmit,
}: {
  node: CanvasNode | null;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
}) {
  const t = useTranslations("canvas");
  const [prompt, setPrompt] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  // 打开时预填目标节点提示词并聚焦
  React.useEffect(() => {
    if (node) {
      setPrompt(node.prompt);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [node]);

  if (!node) {
    return null;
  }

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("nodeRegenerate")}
        className="w-full max-w-lg rounded-2xl border border-border/70 bg-background/95 p-4 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("regenerateTitle")}</h2>
          <button
            type="button"
            aria-label={t("closePanel")}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("regenerateHint")}</p>
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          rows={4}
          className="mt-3 w-full resize-none rounded-xl border border-border/70 bg-transparent p-3 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary/40"
          placeholder={t("promptPlaceholder")}
        />
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-muted-foreground">{node.model}</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
              onClick={onClose}
            >
              {t("regenerateCancel")}
            </button>
            <button
              type="button"
              disabled={!prompt.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
              onClick={submit}
            >
              <RefreshCw className="size-3.5" strokeWidth={1.8} />
              {t("regenerateAction")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
