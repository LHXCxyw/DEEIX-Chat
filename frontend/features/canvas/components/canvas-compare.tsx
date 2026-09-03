"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Columns2, X } from "lucide-react";

import type { CanvasDoneNode, CanvasNode } from "@/features/canvas/model/canvas-types";

export function CanvasCompare({ nodes, onClose }: { nodes: CanvasNode[]; onClose: () => void }) {
  const t = useTranslations("canvas");
  const done = nodes.filter(
    (node): node is CanvasDoneNode & { objectURL: string } => node.status === "done" && Boolean(node.objectURL),
  ).slice(0, 2);
  const [split, setSplit] = React.useState(50);
  if (done.length !== 2) return null;
  return (
    <div data-canvas-ui="compare" className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur-xl">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border p-3 text-sm font-medium"><Columns2 className="size-4" />{t("compareTitle")}<span className="ml-auto text-xs text-muted-foreground">{t("compareHint")}</span><button type="button" aria-label={t("nodePreviewClose")} className="rounded-lg p-2 text-muted-foreground hover:bg-accent" onClick={onClose}><X className="size-4" /></button></header>
        <div className="relative mx-auto min-h-0 w-full flex-1 overflow-hidden bg-black/90" style={{ aspectRatio: "16 / 10" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}<img src={done[0].objectURL} alt={done[0].prompt} className="absolute inset-0 size-full object-contain" />
          <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${split}%` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}<img src={done[1].objectURL} alt={done[1].prompt} className="h-full max-w-none object-contain" style={{ width: "min(100vw, 1024px)" }} />
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_12px_black]" style={{ left: `${split}%` }} />
          <input aria-label={t("comparePosition")} type="range" min="0" max="100" value={split} onChange={(event) => setSplit(Number(event.target.value))} className="absolute inset-0 size-full cursor-col-resize opacity-0" />
          <span className="absolute left-3 bottom-3 rounded-md bg-black/60 px-2 py-1 text-xs text-white">{done[1].model} · V{done[1].version ?? 1}</span>
          <span className="absolute right-3 bottom-3 rounded-md bg-black/60 px-2 py-1 text-xs text-white">{done[0].model} · V{done[0].version ?? 1}</span>
        </div>
      </div>
    </div>
  );
}
