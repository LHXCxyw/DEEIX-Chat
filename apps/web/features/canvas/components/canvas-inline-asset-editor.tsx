"use client";

import { ArrowUp, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import type { CanvasModelOption } from "@/features/canvas/model/canvas-image-options";
import { cn } from "@/lib/utils";

export type InlineEditMode = "inpaint" | "outpaint" | "crop";

export type InlineEditPayload = {
  mode: InlineEditMode;
  prompt: string;
  model: CanvasModelOption;
  image: File;
  mask?: File;
  outputWidth: number;
  outputHeight: number;
};

type Rect = { x: number; y: number; width: number; height: number };

const RATIO_OPTIONS = [
  { label: "原比例", value: null },
  { label: "1:1", value: 1 },
  { label: "16:9", value: 16 / 9 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "9:16", value: 9 / 16 },
  { label: "21:9", value: 21 / 9 },
];

// 扩图默认选区大于原图，四周留出可以向外扩展的余量；裁剪仍需裁在图片内
function initialCrop(mode: InlineEditMode): Rect {
  return mode === "outpaint"
    ? { x: -20, y: -20, width: 140, height: 140 }
    : { x: 10, y: 10, width: 80, height: 80 };
}

// 斜线蒙版：用于区分选区里超出原图的部分
const HATCH_STYLE: React.CSSProperties = {
  backgroundImage: "repeating-linear-gradient(45deg, rgba(15,23,42,0.16) 0 5px, rgba(15,23,42,0) 5px 10px)",
};

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = source;
  });
}

// 画布内联素材编辑：直接在节点图区域上绘制裁剪框/蒙版，下方浮出比例与提示词操作条
export function CanvasInlineAssetEditor({
  mode,
  sourceURL,
  fileName,
  model,
  rect,
  busy,
  onSubmit,
}: {
  mode: InlineEditMode;
  sourceURL: string;
  fileName?: string;
  model: CanvasModelOption;
  // 节点预览区在画布容器内的屏幕坐标与尺寸
  rect: { left: number; top: number; width: number; height: number };
  busy: boolean;
  onSubmit: (payload: InlineEditPayload) => void;
}) {
  const t = useTranslations("canvas");
  const [prompt, setPrompt] = React.useState("");
  // 裁剪框（百分比）：裁剪与扩图共用
  const [crop, setCrop] = React.useState<Rect>(() => initialCrop(mode));
  const [ratio, setRatio] = React.useState<number | null>(null);
  const maskRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef(false);
  type DragKind = "move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "w" | "e";
  const dragRef = React.useRef<{ kind: DragKind; startX: number; startY: number; rect: Rect } | null>(null);

  // 切换编辑模式时重置选区：扩图默认超出原图，裁剪默认内缩
  React.useEffect(() => {
    setCrop(initialCrop(mode));
    setRatio(null);
  }, [mode]);

  // 初始化蒙版画布尺寸与裁剪框比例
  React.useEffect(() => {
    if (mode === "inpaint") {
      const canvas = maskRef.current;
      if (canvas) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        const context = canvas.getContext("2d");
        if (context) {
          context.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
    }
  }, [mode, rect.height, rect.width]);

  // 选择比例：调整裁剪框为对应宽高比并居中
  const applyRatio = (value: number | null) => {
    setRatio(value);
    if (!value) {
      setCrop(initialCrop(mode));
      return;
    }
    const previewAspect = rect.width / Math.max(1, rect.height);
    let width = 80;
    let height = 80;
    if (value >= previewAspect) {
      height = (80 * previewAspect) / value;
    } else {
      width = (80 * value) / previewAspect;
    }
    setCrop({ x: (100 - width) / 2, y: (100 - height) / 2, width, height });
  };

  const drawMask = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) {
      return;
    }
    const canvas = maskRef.current;
    if (!canvas) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.fillStyle = "rgba(59,130,246,0.5)";
    context.beginPath();
    context.arc(event.clientX - bounds.left, event.clientY - bounds.top, 18, 0, Math.PI * 2);
    context.fill();
  };

  const beginCropDrag = (event: React.PointerEvent, kind: DragKind) => {
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, rect: crop };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const moveCrop = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const dx = ((event.clientX - drag.startX) / Math.max(1, rect.width)) * 100;
    const dy = ((event.clientY - drag.startY) / Math.max(1, rect.height)) * 100;
    // 扩图允许把选区拖到原图之外，裁剪限制在图片内
    const minX = mode === "outpaint" ? -60 : 0;
    const minY = mode === "outpaint" ? -60 : 0;
    const maxX = mode === "outpaint" ? 160 : 100;
    const maxY = mode === "outpaint" ? 160 : 100;
    const next = { ...drag.rect };
    if (drag.kind === "move") {
      next.x = Math.min(Math.max(minX, drag.rect.x + dx), maxX - drag.rect.width);
      next.y = Math.min(Math.max(minY, drag.rect.y + dy), maxY - drag.rect.height);
    } else {
      if (drag.kind.includes("w")) {
        const width = Math.min(Math.max(10, drag.rect.width - dx), drag.rect.x + drag.rect.width - minX);
        next.x = drag.rect.x + drag.rect.width - width;
        next.width = width;
      }
      if (drag.kind.includes("e")) {
        next.width = Math.min(Math.max(10, drag.rect.width + dx), maxX - drag.rect.x);
      }
      if (drag.kind.includes("n")) {
        const height = Math.min(Math.max(10, drag.rect.height - dy), drag.rect.y + drag.rect.height - minY);
        next.y = drag.rect.y + drag.rect.height - height;
        next.height = height;
      }
      if (drag.kind.includes("s")) {
        next.height = Math.min(Math.max(10, drag.rect.height + dy), maxY - drag.rect.y);
      }
    }
    setCrop(next);
  };

  const endCropDrag = () => {
    dragRef.current = null;
  };

  const submit = async () => {
    if (!prompt.trim() || busy) {
      return;
    }
    try {
      const image = await loadImage(sourceURL);
      const naturalWidth = image.naturalWidth || 1;
      const naturalHeight = image.naturalHeight || 1;
      if (mode === "inpaint") {
        const canvas = maskRef.current;
        if (!canvas) {
          return;
        }
        const output = document.createElement("canvas");
        output.width = naturalWidth;
        output.height = naturalHeight;
        output.getContext("2d")?.drawImage(image, 0, 0);
        const mask = document.createElement("canvas");
        mask.width = naturalWidth;
        mask.height = naturalHeight;
        const context = mask.getContext("2d");
        if (context) {
          context.drawImage(canvas, 0, 0, naturalWidth, naturalHeight);
          // 蒙版需要不透明白底 + 透明挖空区域，交给模型识别编辑范围
          const inverted = document.createElement("canvas");
          inverted.width = naturalWidth;
          inverted.height = naturalHeight;
          const invertedContext = inverted.getContext("2d");
          if (invertedContext) {
            invertedContext.fillStyle = "#ffffff";
            invertedContext.fillRect(0, 0, naturalWidth, naturalHeight);
            invertedContext.globalCompositeOperation = "destination-out";
            invertedContext.drawImage(canvas, 0, 0, naturalWidth, naturalHeight);
          }
          context.clearRect(0, 0, naturalWidth, naturalHeight);
          context.drawImage(inverted, 0, 0);
        }
        const imageBlob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
        const maskBlob = await new Promise<Blob | null>((resolve) => mask.toBlob(resolve, "image/png"));
        if (!imageBlob || !maskBlob) {
          return;
        }
        onSubmit({
          mode,
          prompt,
          model,
          image: new File([imageBlob], `${fileName ?? "edit"}.png`, { type: "image/png" }),
          mask: new File([maskBlob], `${fileName ?? "edit"}-mask.png`, { type: "image/png" }),
          outputWidth: naturalWidth,
          outputHeight: naturalHeight,
        });
        return;
      }
      // 裁剪 / 扩图统一按选区生成目标画面：扩图选区可以超出原图，超出部分留白交给模型补全
      const outputWidth = Math.max(16, Math.round((naturalWidth * crop.width) / 100));
      const outputHeight = Math.max(16, Math.round((naturalHeight * crop.height) / 100));
      const output = document.createElement("canvas");
      output.width = outputWidth;
      output.height = outputHeight;
      output.getContext("2d")?.drawImage(
        image,
        Math.round((-naturalWidth * crop.x) / 100),
        Math.round((-naturalHeight * crop.y) / 100),
      );
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
      if (!blob) {
        return;
      }
      onSubmit({
        mode,
        prompt,
        model,
        image: new File([blob], `${fileName ?? "edit"}.png`, { type: "image/png" }),
        outputWidth,
        outputHeight,
      });
    } catch {
      // 构建编辑画面失败时保持面板，允许重试
    }
  };

  const cropStyle = {
    left: `${crop.x}%`,
    top: `${crop.y}%`,
    width: `${crop.width}%`,
    height: `${crop.height}%`,
  };

  return (
    <div
      data-canvas-ui="inline-asset-editor"
      className="pointer-events-none absolute z-50"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* 蒙版绘制层 */}
      {mode === "inpaint" ? (
        <canvas
          ref={maskRef}
          className="pointer-events-auto absolute inset-0 size-full cursor-crosshair touch-none"
          onPointerDown={(event) => {
            event.stopPropagation();
            drawingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            drawMask(event);
          }}
          onPointerMove={drawMask}
          onPointerUp={() => {
            drawingRef.current = false;
          }}
          onPointerCancel={() => {
            drawingRef.current = false;
          }}
        />
      ) : (
        <>
          {/* 扩图选区超出原图的部分用斜线蒙版标注 */}
          {mode === "outpaint"
            ? hatchRects(crop).map((item, index) => (
              <span
                key={`hatch-${index}`}
                className="pointer-events-none absolute border border-primary/25"
                style={{
                  ...HATCH_STYLE,
                  left: `${item.x}%`,
                  top: `${item.y}%`,
                  width: `${item.width}%`,
                  height: `${item.height}%`,
                }}
              />
            ))
            : null}
          <div
            className="pointer-events-auto absolute inset-0 touch-none border border-primary/40"
            onPointerDown={(event) => beginCropDrag(event, "move")}
            onPointerMove={moveCrop}
            onPointerUp={endCropDrag}
            onPointerCancel={endCropDrag}
            style={cropStyle}
          >
            <span className="pointer-events-none absolute inset-0 bg-primary/5 ring-2 ring-primary" />
            {(["nw", "ne", "sw", "se"] as const).map((corner) => (
              <button
                key={corner}
                type="button"
                aria-label={corner}
                className={cn(
                  "absolute z-10 size-3 rounded-sm border border-primary-foreground bg-primary shadow",
                  corner === "nw" && "-left-1.5 -top-1.5 cursor-nwse-resize",
                  corner === "ne" && "-right-1.5 -top-1.5 cursor-nesw-resize",
                  corner === "sw" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                  corner === "se" && "-bottom-1.5 -right-1.5 cursor-nwse-resize",
                )}
                onPointerDown={(event) => beginCropDrag(event, corner)}
                onPointerMove={moveCrop}
                onPointerUp={endCropDrag}
                onPointerCancel={endCropDrag}
              />
            ))}
            {/* 四条边可单独拖动，不必只能拉角 */}
            {([
              { kind: "n", className: "left-1/2 top-0 h-2 w-8 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize" },
              { kind: "s", className: "bottom-0 left-1/2 h-2 w-8 -translate-x-1/2 translate-y-1/2 cursor-ns-resize" },
              { kind: "w", className: "left-0 top-1/2 h-8 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
              { kind: "e", className: "right-0 top-1/2 h-8 w-2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
            ] as const).map((edge) => (
              <button
                key={edge.kind}
                type="button"
                aria-label={edge.kind}
                className={cn("absolute z-10 rounded-sm bg-primary/80 opacity-70 hover:opacity-100", edge.className)}
                onPointerDown={(event) => beginCropDrag(event, edge.kind)}
                onPointerMove={moveCrop}
                onPointerUp={endCropDrag}
                onPointerCancel={endCropDrag}
              />
            ))}
            <span className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-background/90 px-1.5 py-0.5 text-[10px] tabular-nums">
              {formatSize(crop)}
            </span>
          </div>
        </>
      )}

      {/* 下方操作条：比例选择 + 提示词 */}
      <div
        className="pointer-events-auto absolute left-1/2 top-full mt-2 w-[min(34rem,90vw)] -translate-x-1/2 space-y-1.5"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {mode !== "inpaint" ? (
          <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-border/60 bg-background/95 p-1 shadow-lg backdrop-blur">
            {RATIO_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className={cn(
                  "shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors",
                  ratio === option.value ? "bg-primary/10 font-medium text-primary ring-1 ring-primary/30" : "text-muted-foreground hover:bg-accent",
                )}
                onClick={() => applyRatio(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/95 p-1.5 shadow-lg backdrop-blur">
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={t("editorPromptPlaceholder")}
            className="h-9 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            disabled={busy || !prompt.trim()}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.8} /> : <ArrowUp className="size-4" strokeWidth={2} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSize(crop: Rect): string {
  return `${Math.round(crop.width)}% × ${Math.round(crop.height)}%`;
}

// 选区超出原图（0~100%）的部分：分别返回上/下/左/右四块斜线区域
function hatchRects(crop: Rect): Rect[] {
  const left = crop.x;
  const right = crop.x + crop.width;
  const top = crop.y;
  const bottom = crop.y + crop.height;
  const rects: Rect[] = [];
  if (left < 0) {
    rects.push({ x: left, y: top, width: Math.min(0, right) - left, height: crop.height });
  }
  if (right > 100) {
    rects.push({ x: Math.max(100, left), y: top, width: right - Math.max(100, left), height: crop.height });
  }
  if (top < 0) {
    rects.push({
      x: Math.max(0, left),
      y: top,
      width: Math.min(100, right) - Math.max(0, left),
      height: Math.min(0, bottom) - top,
    });
  }
  if (bottom > 100) {
    rects.push({
      x: Math.max(0, left),
      y: Math.max(100, top),
      width: Math.min(100, right) - Math.max(0, left),
      height: bottom - Math.max(100, top),
    });
  }
  return rects.filter((item) => item.width > 0 && item.height > 0);
}
