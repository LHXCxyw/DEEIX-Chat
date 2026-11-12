"use client";

import { Camera, Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}

// 自定义截帧：视频预览 + 帧缩略图时间线，拖动或用播放控制选择画面后截取
export function CanvasFrameCaptureDialog({
  open,
  source,
  fileName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  source?: string;
  fileName?: string;
  onConfirm: (seconds: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations("canvas");
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const [duration, setDuration] = React.useState(0);
  const [current, setCurrent] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [muted, setMuted] = React.useState(true);
  const [captured, setCaptured] = React.useState<number | null>(null);
  const [frames, setFrames] = React.useState<string[]>([]);
  const cancelledRef = React.useRef(false);
  // 抽取缩略帧时会连续 seek，期间忽略 timeupdate，避免时间码来回跳动
  const extractingRef = React.useRef(false);

  // 重置状态：每次打开重新读取时长与缩略帧
  React.useEffect(() => {
    if (!open) {
      return;
    }
    cancelledRef.current = false;
    setFrames([]);
    setCaptured(null);
    setCurrent(0);
    setPlaying(false);
    setDuration(0);
    return () => {
      cancelledRef.current = true;
    };
  }, [open, source]);

  // 生成帧缩略图：顺序 seek 后绘制到离屏 canvas，作为时间线底图
  const extractFrames = React.useCallback(async (video: HTMLVideoElement) => {
    const total = video.duration;
    if (!Number.isFinite(total) || total <= 0) {
      return;
    }
    const count = 8;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d");
    const shots: string[] = [];
    for (let index = 0; index < count; index += 1) {
      if (cancelledRef.current) {
        return;
      }
      const at = Math.min(Math.max(0.05, (total * (index + 0.5)) / count), Math.max(0, total - 0.05));
      await new Promise<void>((resolve) => {
        const seeked = () => {
          video.removeEventListener("seeked", seeked);
          resolve();
        };
        video.addEventListener("seeked", seeked, { once: true });
        try {
          video.currentTime = at;
        } catch {
          resolve();
        }
      });
      context?.drawImage(video, 0, 0, canvas.width, canvas.height);
      shots.push(canvas.toDataURL("image/jpeg", 0.6));
    }
    if (!cancelledRef.current) {
      setFrames(shots);
    }
  }, []);

  // 元信息就绪：读取时长并抽取缩略帧（视频元素可能晚于组件挂载，交给元素自身事件）
  const handleLoadedMetadata = (video: HTMLVideoElement) => {
    const total = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(total);
    extractingRef.current = true;
    void extractFrames(video).finally(() => {
      extractingRef.current = false;
      if (cancelledRef.current) {
        return;
      }
      try {
        video.currentTime = 0;
      } catch {
        // 忽略定位失败
      }
      setCurrent(0);
    });
  };

  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const next = Math.min(Math.max(0, seconds), Math.max(0, (video.duration || 0) - 0.02));
    try {
      video.currentTime = next;
      setCurrent(next);
    } catch {
      // 忽略定位失败
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const progress = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;

  // 缩略时间线：按比例定位（不再依赖隐藏的 range 输入，避免无法拖动）
  const seekFromStrip = (clientX: number, element: HTMLElement) => {
    if (duration <= 0) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seek(duration * ratio);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) {
        onClose();
      }
    }}>
      <DialogContent
        data-canvas-ui="frame-capture"
        className="max-w-[min(56rem,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl border-border/60 p-0"
      >
        <DialogTitle className="sr-only">{t("frameCaptureTitle")}</DialogTitle>
        <div className="flex flex-col gap-0">
          <div ref={stageRef} className="relative bg-black">
            {source ? (
              <video
                ref={videoRef}
                src={source}
                muted={muted}
                playsInline
                preload="auto"
                className="max-h-[58vh] w-full object-contain"
                onLoadedMetadata={(event) => handleLoadedMetadata(event.currentTarget)}
                onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
                onTimeUpdate={(event) => {
                  if (!extractingRef.current) {
                    setCurrent(event.currentTarget.currentTime);
                  }
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
            ) : (
              <div className="flex h-56 items-center justify-center text-xs text-muted-foreground">{t("extractFrameFailed")}</div>
            )}
            {/* 画面右下角：静音与全屏 */}
            <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
              <button
                type="button"
                aria-label={muted ? "unmute" : "mute"}
                className="flex size-8 items-center justify-center rounded-full bg-background/85 text-foreground/80 shadow backdrop-blur transition-colors hover:bg-background"
                onClick={() => setMuted((value) => !value)}
              >
                {muted ? <VolumeX className="size-4" strokeWidth={1.8} /> : <Volume2 className="size-4" strokeWidth={1.8} />}
              </button>
              <button
                type="button"
                aria-label={t("timelineFullscreen")}
                className="flex size-8 items-center justify-center rounded-full bg-background/85 text-foreground/80 shadow backdrop-blur transition-colors hover:bg-background"
                onClick={() => void stageRef.current?.requestFullscreen?.().catch(() => undefined)}
              >
                <Maximize2 className="size-4" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {/* 帧缩略时间线：点击或拖动定位，竖向播放头显示当前帧 */}
          <div
            className="relative mx-3 mt-3 h-16 cursor-pointer overflow-hidden rounded-lg bg-muted/60 touch-none"
            onPointerDown={(event) => {
              const element = event.currentTarget;
              event.stopPropagation();
              element.setPointerCapture?.(event.pointerId);
              seekFromStrip(event.clientX, element);
              const onMove = (moveEvent: PointerEvent) => seekFromStrip(moveEvent.clientX, element);
              const onUp = (upEvent: PointerEvent) => {
                element.releasePointerCapture?.(upEvent.pointerId);
                element.removeEventListener("pointermove", onMove);
                element.removeEventListener("pointerup", onUp);
                element.removeEventListener("pointercancel", onUp);
              };
              element.addEventListener("pointermove", onMove);
              element.addEventListener("pointerup", onUp);
              element.addEventListener("pointercancel", onUp);
            }}
          >
            <div className="pointer-events-none flex h-full w-full">
              {(frames.length > 0 ? frames : Array.from({ length: 8 }, () => "")).map((frame, index) => (
                <div
                  key={`${index}-${frame.slice(-8)}`}
                  className="relative h-full min-w-0 flex-1 overflow-hidden border-r border-background/40 last:border-r-0"
                >
                  {frame ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={frame} alt="" className="size-full object-cover" draggable={false} />
                  ) : null}
                </div>
              ))}
            </div>
            <span
              className="pointer-events-none absolute top-0 h-full w-0.5 bg-primary shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
              style={{ left: `${progress}%` }}
            />
            {duration <= 0 ? (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
                {t("timelineEmpty")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 px-3 text-[10px] leading-relaxed text-muted-foreground">{t("frameCaptureHint")}</p>

          <div className="mt-2 flex items-center gap-2 border-t border-border/50 p-3">
            <button
              type="button"
              aria-label={playing ? t("timelinePause") : t("timelinePlay")}
              className="flex size-8 items-center justify-center rounded-lg text-foreground/85 transition-colors hover:bg-accent"
              onClick={togglePlay}
            >
              {playing ? <Pause className="size-4" strokeWidth={1.8} /> : <Play className="size-4" strokeWidth={1.8} />}
            </button>
            <span className="text-[11px] tabular-nums text-foreground/85">
              {formatClock(captured ?? current)} <span className="text-muted-foreground">/ {formatClock(duration)}</span>
            </span>
            {fileName ? <span className="min-w-0 truncate text-[10px] text-muted-foreground">{fileName}</span> : null}
            <button
              type="button"
              className={cn(
                "ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/70 px-3 text-xs transition-colors hover:bg-accent",
                captured !== null && "border-primary/60 text-primary",
              )}
              onClick={() => setCaptured(current)}
            >
              <Camera className="size-3.5" strokeWidth={1.8} />
              {t("frameCaptureAt")}
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              onClick={() => onConfirm(captured ?? current)}
            >
              {t("frameCaptureConfirm")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
