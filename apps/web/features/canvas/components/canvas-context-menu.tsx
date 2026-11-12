"use client";

import { ClipboardPaste, Copy, Frame, Lock, LockOpen, MessageSquareText, MousePointerSquareDashed, Redo2, Trash2, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

export type CanvasContextAction =
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "toggleLock"
  | "undo"
  | "redo"
  | "addFrame"
  | "addNote"
  | "selectAll";

export type CanvasContextMenuState = {
  x: number;
  y: number;
  kind: "node" | "decoration" | "canvas";
  locked: boolean;
};

// 节点图右键菜单：复制副本 / 删除 / 锁定 / 撤销 / 重做等操作统一收纳在此
export function CanvasContextMenu({
  state,
  canUndo,
  canRedo,
  canPaste,
  onAction,
  onClose,
}: {
  state: CanvasContextMenuState | null;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  onAction: (action: CanvasContextAction) => void;
  onClose: () => void;
}) {
  const t = useTranslations("canvas.contextMenu");
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!state) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, state]);

  if (!state) {
    return null;
  }

  const item = (action: CanvasContextAction, label: string, icon: React.ReactNode, disabled = false, destructive = false) => (
    <button
      key={action}
      type="button"
      disabled={disabled}
      className={[
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
        destructive ? "text-destructive hover:bg-destructive/10" : "text-foreground/85 hover:bg-accent",
        "disabled:pointer-events-none disabled:opacity-40",
      ].join(" ")}
      onClick={() => {
        onAction(action);
        onClose();
      }}
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );

  const isCanvas = state.kind === "canvas";
  const isNode = state.kind === "node";

  return (
    <div
      ref={ref}
      data-canvas-ui="context-menu"
      role="menu"
      className="pointer-events-auto absolute z-40 w-44 rounded-xl border border-border/60 bg-background/95 p-1 shadow-2xl backdrop-blur-2xl"
      style={{ left: state.x, top: state.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {isCanvas ? (
        <>
          {item("paste", t("pasteNodes"), <ClipboardPaste className="size-3.5" strokeWidth={1.8} />, !canPaste)}
          {item("addFrame", t("addFrame"), <Frame className="size-3.5" strokeWidth={1.8} />)}
          {item("addNote", t("addNote"), <MessageSquareText className="size-3.5" strokeWidth={1.8} />)}
          {item("selectAll", t("selectAll"), <MousePointerSquareDashed className="size-3.5" strokeWidth={1.8} />)}
          <div className="my-1 h-px bg-border/60" />
        </>
      ) : (
        <>
          {isNode ? item("copy", t("copyNodes"), <Copy className="size-3.5" strokeWidth={1.8} />) : null}
          {isNode ? item("duplicate", t("duplicate"), <Copy className="size-3.5" strokeWidth={1.8} />) : null}
          {item("toggleLock", state.locked ? t("unlock") : t("lock"), state.locked
            ? <LockOpen className="size-3.5" strokeWidth={1.8} />
            : <Lock className="size-3.5" strokeWidth={1.8} />)}
          {item("delete", t("delete"), <Trash2 className="size-3.5" strokeWidth={1.8} />, false, true)}
          <div className="my-1 h-px bg-border/60" />
        </>
      )}
      {item("undo", t("undo"), <Undo2 className="size-3.5" strokeWidth={1.8} />, !canUndo)}
      {item("redo", t("redo"), <Redo2 className="size-3.5" strokeWidth={1.8} />, !canRedo)}
    </div>
  );
}
