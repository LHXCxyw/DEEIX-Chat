"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Download, X } from "lucide-react";

import type { CanvasNode } from "@/features/canvas/model/canvas-types";

export function CanvasImageLightbox({
  node,
  onClose,
  onDownload,
}: {
  node: CanvasNode | null;
  onClose: () => void;
  onDownload: (node: CanvasNode) => void;
}) {
  const t = useTranslations("canvas");

  React.useEffect(() => {
    if (!node) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [node, onClose]);

  if (!node || node.status !== "done" || !node.objectURL) {
    return null;
  }

  return (
    <div
      data-canvas-ui="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("nodePreviewTitle")}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/85 p-6 backdrop-blur-md"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex w-full max-w-4xl items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground select-text" title={node.prompt}>
          {node.prompt}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={t("nodeDownload")}
            title={t("nodeDownload")}
            className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background/90 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => onDownload(node)}
          >
            <Download className="size-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label={t("nodePreviewClose")}
            title={t("nodePreviewClose")}
            className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background/90 text-muted-foreground transition-colors hover:text-foreground"
            onClick={onClose}
          >
            <X className="size-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {/* 原图可右键复制或另存 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt={node.prompt}
        className="max-h-[calc(100%-4rem)] max-w-full rounded-xl border border-border/60 object-contain shadow-2xl"
        src={node.objectURL}
      />
    </div>
  );
}
