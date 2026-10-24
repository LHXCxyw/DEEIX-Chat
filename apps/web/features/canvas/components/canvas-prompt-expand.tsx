"use client";

import { X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

// 提示词全屏输入：挂载到 body 上渲染。
// 不能直接嵌在输入条 / 节点内——父级的 backdrop-filter 会为 fixed 元素创建新的包含块，
// 导致「全屏」被压缩到父容器大小。
export function CanvasPromptExpandDialog({
  open,
  title,
  value,
  placeholder,
  onChange,
  onClose,
  footer,
}: {
  open: boolean;
  title: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  // 回调存入 ref：输入过程中父级频繁重渲染，不因此重跑聚焦与键盘监听
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    if (!open) {
      return;
    }
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // 标记为画布浮层：避免点击冒泡到画布根节点触发框选/平移并抢占 pointer capture，
      // 否则关闭按钮的 click 会被画布节点吞掉
      data-canvas-ui="prompt-expand"
      className="fixed inset-0 z-[60] flex flex-col bg-background/95 p-3 backdrop-blur-md motion-reduce:backdrop-blur-none sm:p-6"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
          <button
            type="button"
            aria-label={title}
            className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background/90 text-muted-foreground transition-colors hover:text-foreground"
            onClick={onClose}
          >
            <X className="size-4" strokeWidth={1.8} />
          </button>
        </div>
        <textarea
          ref={inputRef}
          aria-label={title}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-h-0 w-full flex-1 resize-none rounded-xl border border-border/70 bg-background/80 px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
        />
        {footer ? <div className="flex shrink-0 justify-end">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
