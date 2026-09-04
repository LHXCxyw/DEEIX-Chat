"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Download, Paintbrush, Repeat2, X } from "lucide-react";

import { trappedFocusIndex } from "@/features/canvas/model/canvas-interactions";
import type { OutputGraphNode } from "@/features/canvas/model/canvas-types";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function CanvasImageLightbox({
  node,
  onClose,
  onUseAsReference,
  onEdit,
  onDownload,
}: {
  node: OutputGraphNode | null;
  onClose: () => void;
  onUseAsReference: (node: OutputGraphNode) => void;
  onEdit: (node: OutputGraphNode) => void;
  onDownload: (node: OutputGraphNode) => void;
}) {
  const t = useTranslations("canvas");
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!node) {
      return;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [node]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = trappedFocusIndex(currentIndex, focusable.length, event.shiftKey);
      if (nextIndex !== null && nextIndex !== currentIndex) {
        event.preventDefault();
        focusable[nextIndex].focus();
      }
    },
    [onClose],
  );

  if (!node || node.status !== "done" || !node.objectURL) {
    return null;
  }

  return (
    <div
      ref={dialogRef}
      data-canvas-ui="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("nodePreviewTitle")}
      tabIndex={-1}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/85 p-6 backdrop-blur-md motion-reduce:backdrop-blur-none"
      onKeyDown={handleKeyDown}
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
          {[
            { label: t("nodeUseAsReference"), icon: Repeat2, action: onUseAsReference },
            { label: t("nodeEdit"), icon: Paintbrush, action: onEdit },
            { label: t("nodeDownload"), icon: Download, action: onDownload },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              aria-label={item.label}
              title={item.label}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-background/90 px-2.5 text-xs text-muted-foreground transition-colors motion-reduce:transition-none hover:border-primary/30 hover:text-foreground"
              onClick={() => item.action(node)}
            >
              <item.icon className="size-3.5" strokeWidth={1.8} />
              <span className="hidden lg:inline">{item.label}</span>
            </button>
          ))}
          <button
            ref={closeButtonRef}
            type="button"
            aria-label={t("nodePreviewClose")}
            title={t("nodePreviewClose")}
            className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background/90 text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground"
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
