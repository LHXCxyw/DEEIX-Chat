"use client";

import { Brush, Crop, Eraser, Expand, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { CanvasModelSelect } from "@/features/canvas/components/canvas-model-select";
import { resolveCanvasRoute } from "@/features/canvas/model/canvas-image-options";
import type { ImageGraphNode, OutputGraphNode } from "@/features/canvas/model/canvas-types";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { cn } from "@/lib/utils";

type EditorMode = "inpaint" | "crop" | "outpaint";
type CropRect = { x: number; y: number; width: number; height: number };
type CropHandle = "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type OutpaintSides = { top: number; right: number; bottom: number; left: number };

const MIN_CROP_SIZE = 5;
const CROP_HANDLES: { id: Exclude<CropHandle, "move">; className: string; cursor: string }[] = [
  { id: "nw", className: "-left-1.5 -top-1.5", cursor: "cursor-nwse-resize" },
  { id: "n", className: "left-1/2 -top-1.5 -translate-x-1/2", cursor: "cursor-ns-resize" },
  { id: "ne", className: "-right-1.5 -top-1.5", cursor: "cursor-nesw-resize" },
  { id: "e", className: "-right-1.5 top-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
  { id: "se", className: "-bottom-1.5 -right-1.5", cursor: "cursor-nwse-resize" },
  { id: "s", className: "-bottom-1.5 left-1/2 -translate-x-1/2", cursor: "cursor-ns-resize" },
  { id: "sw", className: "-bottom-1.5 -left-1.5", cursor: "cursor-nesw-resize" },
  { id: "w", className: "-left-1.5 top-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
];

function canvasToFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("无法处理图像"));
        return;
      }
      resolve(new File([blob], name, { type: "image/png" }));
    }, "image/png");
  });
}

export function CanvasImageEditor({
  node,
  sourceURL,
  imageModels,
  defaultModel,
  onClose,
  onSubmit,
}: {
  // 支持输出节点（自 objectURL 加载）与参考图节点（自 sourceURL 的 blob 地址加载）
  node: OutputGraphNode | ImageGraphNode | null;
  sourceURL?: string;
  imageModels: ChatModelOption[];
  defaultModel: ChatModelOption | null;
  onClose: () => void;
  onSubmit: (input: { prompt: string; mode: EditorMode; image: File; mask?: File; model: ChatModelOption; outputWidth: number; outputHeight: number }) => Promise<boolean>;
}) {
  const t = useTranslations("canvas");
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const maskRef = React.useRef<HTMLCanvasElement | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const drawingRef = React.useRef(false);
  const cropDragRef = React.useRef<{ handle: CropHandle; x: number; y: number; rect: CropRect } | null>(null);
  const [mode, setMode] = React.useState<EditorMode>("inpaint");
  const [prompt, setPrompt] = React.useState("");
  const [cropRect, setCropRect] = React.useState<CropRect>({ x: 10, y: 10, width: 80, height: 80 });
  const [outpaint, setOutpaint] = React.useState<OutpaintSides>({ top: 20, right: 20, bottom: 20, left: 20 });
  const [brushSize, setBrushSize] = React.useState(5);
  const [busy, setBusy] = React.useState(false);
  const [, setImageRevision] = React.useState(0);
  const editableModels = React.useMemo(
    () => imageModels.filter((model) => resolveCanvasRoute(model, true).route !== null),
    [imageModels],
  );
  const [selectedModelName, setSelectedModelName] = React.useState("");
  const selectedModel = editableModels.find((model) => model.platformModelName === selectedModelName)
    ?? editableModels.find((model) => model.platformModelName === (node?.kind === "output" ? node.model : undefined))
    ?? (defaultModel && resolveCanvasRoute(defaultModel, true).route !== null ? defaultModel : null)
    ?? editableModels[0]
    ?? null;

  const resetMask = React.useCallback(() => {
    const image = imageRef.current;
    const display = canvasRef.current;
    if (!image || !display) return;
    display.width = image.naturalWidth;
    display.height = image.naturalHeight;
    display.getContext("2d")?.drawImage(image, 0, 0);
    const mask = document.createElement("canvas");
    mask.width = image.naturalWidth;
    mask.height = image.naturalHeight;
    const context = mask.getContext("2d");
    if (!context) return;
    context.fillStyle = "white";
    context.fillRect(0, 0, mask.width, mask.height);
    maskRef.current = mask;
  }, []);

  // 图源：参考图节点用 workspace 预解析的 blob 地址（避免远程 URL 污染画布导出），输出节点用自身 objectURL
  const sourceSrc = sourceURL ?? (node?.kind === "output" ? node.objectURL : undefined);

  React.useEffect(() => {
    if (!node) {
      setSelectedModelName("");
      return;
    }
    const originalModel = editableModels.find((model) => model.platformModelName === (node.kind === "output" ? node.model : undefined));
    setSelectedModelName(originalModel?.platformModelName ?? defaultModel?.platformModelName ?? editableModels[0]?.platformModelName ?? "");
  }, [defaultModel, editableModels, node]);

  React.useEffect(() => {
    if (!node || !sourceSrc) return;
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      resetMask();
      setImageRevision((value) => value + 1);
    };
    image.src = sourceSrc;
  }, [node, sourceSrc, resetMask]);

  React.useEffect(() => {
    if (mode === "inpaint") resetMask();
  }, [mode, resetMask]);

  const drawMask = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "inpaint" || !drawingRef.current) return;
    const display = canvasRef.current;
    const mask = maskRef.current;
    if (!display || !mask) return;
    const rect = display.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (display.width / rect.width);
    const y = (event.clientY - rect.top) * (display.height / rect.height);
    const radius = Math.max(8, display.width * brushSize / 200);
    const displayContext = display.getContext("2d");
    const maskContext = mask.getContext("2d");
    if (!displayContext || !maskContext) return;
    displayContext.fillStyle = "rgba(99, 102, 241, .55)";
    displayContext.beginPath();
    displayContext.arc(x, y, radius, 0, Math.PI * 2);
    displayContext.fill();
    maskContext.save();
    maskContext.globalCompositeOperation = "destination-out";
    maskContext.beginPath();
    maskContext.arc(x, y, radius, 0, Math.PI * 2);
    maskContext.fill();
    maskContext.restore();
  }, [brushSize, mode]);

  const beginCropDrag = (event: React.PointerEvent<HTMLElement>, handle: CropHandle) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDragRef.current = { handle, x: event.clientX, y: event.clientY, rect: cropRect };
  };

  const moveCrop = (event: React.PointerEvent<HTMLElement>) => {
    const drag = cropDragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const dx = (event.clientX - drag.x) / bounds.width * 100;
    const dy = (event.clientY - drag.y) / bounds.height * 100;
    const start = drag.rect;
    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;

    if (drag.handle === "move") {
      left = Math.max(0, Math.min(100 - start.width, start.x + dx));
      top = Math.max(0, Math.min(100 - start.height, start.y + dy));
      right = left + start.width;
      bottom = top + start.height;
    } else {
      if (drag.handle.includes("w")) left = Math.max(0, Math.min(right - MIN_CROP_SIZE, start.x + dx));
      if (drag.handle.includes("e")) right = Math.min(100, Math.max(left + MIN_CROP_SIZE, start.x + start.width + dx));
      if (drag.handle.includes("n")) top = Math.max(0, Math.min(bottom - MIN_CROP_SIZE, start.y + dy));
      if (drag.handle.includes("s")) bottom = Math.min(100, Math.max(top + MIN_CROP_SIZE, start.y + start.height + dy));
    }
    setCropRect({ x: left, y: top, width: right - left, height: bottom - top });
  };

  const submit = async () => {
    const image = imageRef.current;
    if (!image || !prompt.trim() || !selectedModel) return;
    setBusy(true);
    try {
      const output = document.createElement("canvas");
      const outputContext = output.getContext("2d");
      if (!outputContext) return;
      let mask = maskRef.current ?? undefined;

      if (mode === "crop") {
        const sourceX = Math.round(image.naturalWidth * cropRect.x / 100);
        const sourceY = Math.round(image.naturalHeight * cropRect.y / 100);
        const sourceWidth = Math.max(1, Math.round(image.naturalWidth * cropRect.width / 100));
        const sourceHeight = Math.max(1, Math.round(image.naturalHeight * cropRect.height / 100));
        output.width = sourceWidth;
        output.height = sourceHeight;
        outputContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
        mask = undefined;
      } else if (mode === "outpaint") {
        const padTop = Math.round(image.naturalHeight * outpaint.top / 100);
        const padRight = Math.round(image.naturalWidth * outpaint.right / 100);
        const padBottom = Math.round(image.naturalHeight * outpaint.bottom / 100);
        const padLeft = Math.round(image.naturalWidth * outpaint.left / 100);
        output.width = image.naturalWidth + padLeft + padRight;
        output.height = image.naturalHeight + padTop + padBottom;
        outputContext.drawImage(image, padLeft, padTop);
        mask = document.createElement("canvas");
        mask.width = output.width;
        mask.height = output.height;
        const maskContext = mask.getContext("2d");
        if (!maskContext) return;
        maskContext.fillStyle = "white";
        maskContext.fillRect(padLeft, padTop, image.naturalWidth, image.naturalHeight);
      } else {
        output.width = image.naturalWidth;
        output.height = image.naturalHeight;
        outputContext.drawImage(image, 0, 0);
      }

      const submitted = await onSubmit({
        prompt: prompt.trim(),
        mode,
        image: await canvasToFile(output, `${mode}-source.png`),
        mask: mask ? await canvasToFile(mask, `${mode}-mask.png`) : undefined,
        model: selectedModel,
        // 计算后的输出尺寸：供生成节点同步扩图/裁剪后的分辨率参数
        outputWidth: output.width,
        outputHeight: output.height,
      });
      if (submitted) {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  if (!node || !sourceSrc) return null;

  const sourceWidth = imageRef.current?.naturalWidth ?? 1;
  const sourceHeight = imageRef.current?.naturalHeight ?? 1;
  const padTop = sourceHeight * outpaint.top / 100;
  const padRight = sourceWidth * outpaint.right / 100;
  const padBottom = sourceHeight * outpaint.bottom / 100;
  const padLeft = sourceWidth * outpaint.left / 100;
  const outputWidth = mode === "crop" ? Math.round(sourceWidth * cropRect.width / 100) : mode === "outpaint" ? Math.round(sourceWidth + padLeft + padRight) : sourceWidth;
  const outputHeight = mode === "crop" ? Math.round(sourceHeight * cropRect.height / 100) : mode === "outpaint" ? Math.round(sourceHeight + padTop + padBottom) : sourceHeight;

  const modes: { id: EditorMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "inpaint", label: t("editorInpaint"), icon: Brush },
    { id: "crop", label: t("editorCrop"), icon: Crop },
    { id: "outpaint", label: t("editorOutpaint"), icon: Expand },
  ];

  const outpaintControls: { side: keyof OutpaintSides; label: string }[] = [
    { side: "top", label: t("editorExpandTop") },
    { side: "right", label: t("editorExpandRight") },
    { side: "bottom", label: t("editorExpandBottom") },
    { side: "left", label: t("editorExpandLeft") },
  ];

  return (
    <div data-canvas-ui="image-editor" role="dialog" aria-modal="true" aria-label={t("nodeEdit")} className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-xl sm:p-4">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border p-3">
          {modes.map((item) => (
            <button key={item.id} type="button" onClick={() => setMode(item.id)} className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs", mode === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}>
              <item.icon className="size-3.5" />{item.label}
            </button>
          ))}
          <button type="button" aria-label={t("nodePreviewClose")} className="ml-auto rounded-lg p-2 text-muted-foreground hover:bg-accent" onClick={onClose}><X className="size-4" /></button>
        </header>
        <div className="min-h-0 flex flex-1 items-center justify-center overflow-auto overscroll-contain bg-muted/20 p-3 sm:p-4">
          {mode === "outpaint" ? (
            <div
              className="relative max-h-[58vh] max-w-full overflow-hidden rounded-xl border border-dashed border-primary/70 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,color-mix(in_oklab,var(--primary)_10%,transparent)_10px,color-mix(in_oklab,var(--primary)_10%,transparent)_20px)]"
              style={{ aspectRatio: `${outputWidth} / ${outputHeight}`, width: `min(100%, calc(58vh * ${outputWidth / outputHeight}))` }}
            >
              <canvas
                ref={canvasRef}
                className="absolute object-fill shadow-xl"
                style={{ left: `${padLeft / outputWidth * 100}%`, top: `${padTop / outputHeight * 100}%`, width: `${sourceWidth / outputWidth * 100}%`, height: `${sourceHeight / outputHeight * 100}%` }}
              />
              <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/90 px-2 py-1 text-[10px] font-medium tabular-nums shadow">{outputWidth} × {outputHeight}</span>
            </div>
          ) : (
            <div className="relative inline-flex max-h-[58vh] max-w-full items-center justify-center overflow-hidden rounded-lg shadow-xl">
              <canvas
                ref={canvasRef}
                className={cn("block max-h-[58vh] max-w-full object-contain", mode === "inpaint" && "cursor-crosshair touch-none", mode === "crop" && "opacity-80")}
                onPointerDown={(event) => { drawingRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); drawMask(event); }}
                onPointerMove={drawMask}
                onPointerUp={() => { drawingRef.current = false; }}
                onPointerCancel={() => { drawingRef.current = false; }}
              />
              {mode === "crop" ? (
                <div
                  className="absolute touch-none border-2 border-primary shadow-[0_0_0_9999px_rgb(0_0_0/0.55)]"
                  style={{ left: `${cropRect.x}%`, top: `${cropRect.y}%`, width: `${cropRect.width}%`, height: `${cropRect.height}%` }}
                  onPointerDown={(event) => beginCropDrag(event, "move")}
                  onPointerMove={moveCrop}
                  onPointerUp={() => { cropDragRef.current = null; }}
                  onPointerCancel={() => { cropDragRef.current = null; }}
                >
                  <div className="pointer-events-none absolute inset-0 cursor-move bg-transparent" />
                  {CROP_HANDLES.map((handle) => (
                    <button
                      key={handle.id}
                      type="button"
                      aria-label={t("editorCropHandle")}
                      className={cn("absolute z-10 size-3 rounded-sm border border-primary-foreground bg-primary shadow", handle.className, handle.cursor)}
                      onPointerDown={(event) => beginCropDrag(event, handle.id)}
                      onPointerMove={moveCrop}
                      onPointerUp={() => { cropDragRef.current = null; }}
                      onPointerCancel={() => { cropDragRef.current = null; }}
                    />
                  ))}
                  <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/90 px-2 py-1 text-[10px] font-medium tabular-nums shadow">{outputWidth} × {outputHeight}</span>
                </div>
              ) : null}
            </div>
          )}
        </div>
        <footer className="flex max-h-[42vh] flex-col gap-3 overflow-y-auto overscroll-contain border-t border-border p-3 sm:flex-row sm:flex-wrap sm:items-center">
          {mode === "inpaint" ? (
            <><label className="flex min-h-10 items-center gap-2 text-xs text-muted-foreground"><span>{t("editorBrushSize")}</span><input aria-label={t("editorBrushSize")} type="range" min="1" max="15" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} className="h-1.5 min-w-28 cursor-pointer appearance-none rounded-full bg-muted accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" /></label><button type="button" className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs text-muted-foreground hover:bg-accent" onClick={resetMask}><Eraser className="size-3.5" />{t("editorClearMask")}</button></>
          ) : mode === "crop" ? (
            <span className="text-xs text-muted-foreground">{t("editorCropDragHint")}</span>
          ) : (
            <div className="grid w-full grid-cols-2 gap-x-4 gap-y-2 lg:w-auto lg:grid-cols-4">
              {outpaintControls.map((control) => (
                <label key={control.side} className="grid min-h-10 grid-cols-[2.5rem_minmax(5rem,1fr)_2rem] items-center gap-2 text-xs text-muted-foreground">
                  <span>{control.label}</span>
                  <input aria-label={control.label} type="range" min="0" max="100" value={outpaint[control.side]} onChange={(event) => setOutpaint((current) => ({ ...current, [control.side]: Number(event.target.value) }))} className="h-1.5 min-w-0 cursor-pointer appearance-none rounded-full bg-muted accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
                  <span className="text-right tabular-nums">{outpaint[control.side]}%</span>
                </label>
              ))}
            </div>
          )}
          <CanvasModelSelect
            imageModels={editableModels}
            selectedModel={selectedModel}
            onSelect={setSelectedModelName}
            disabled={busy}
          />
          <Input value={prompt} name="canvas-editor-prompt" aria-label={t("editorPromptPlaceholder")} autoComplete="off" onChange={(event) => setPrompt(event.target.value)} placeholder={t("editorPromptPlaceholder")} className="h-10 min-w-0 flex-1 text-sm sm:min-w-52" />
          <button type="button" disabled={busy || !prompt.trim() || !selectedModel} onClick={() => void submit()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40">{busy ? t("editorProcessing") : t("editorGenerate")}</button>
        </footer>
      </div>
    </div>
  );
}
