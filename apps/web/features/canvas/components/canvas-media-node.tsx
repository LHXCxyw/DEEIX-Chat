"use client";

import { AudioLines, Maximize2, Pause, Play, Upload, Video, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { AssetNameBar, GraphNodeShell } from "@/features/canvas/components/canvas-graph-node-shell";
import type { GraphNodeActionHandlers } from "@/features/canvas/components/canvas-graph-nodes";
import { graphNodeSize, type MediaGraphNode } from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 媒体时间码：mm:ss
function formatMediaClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}

// 音频波形：解码音轨后按峰值画柱状图，已播放部分高亮，可点击/拖动定位
function AudioWaveform({ source, progress = 0, onSeek }: { source?: string; progress?: number; onSeek?: (ratio: number) => void }) {
  const [peaks, setPeaks] = React.useState<number[]>([]);
  const [dragging, setDragging] = React.useState(false);
  React.useEffect(() => {
    if (!source) {
      setPeaks([]);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const buffer = await (await fetch(source)).arrayBuffer();
        const context = new AudioContext();
        const decoded = await context.decodeAudioData(buffer);
        void context.close();
        const channel = decoded.getChannelData(0);
        const bars = 64;
        const block = Math.max(1, Math.floor(channel.length / bars));
        const next: number[] = [];
        for (let index = 0; index < bars; index += 1) {
          let sum = 0;
          for (let offset = 0; offset < block; offset += 1) {
            sum += Math.abs(channel[index * block + offset] ?? 0);
          }
          next.push(Math.min(1, (sum / block) * 5));
        }
        if (!cancelled) {
          setPeaks(next);
        }
      } catch {
        // 解码失败时保留占位波形
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const seekAt = (clientX: number, element: HTMLElement) => {
    if (!onSeek) {
      return;
    }
    const rect = element.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };
  const playedRatio = Math.min(1, Math.max(0, progress));

  if (peaks.length === 0) {
    return <div className="h-12 w-full rounded-md bg-muted/50" />;
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 波形用指针拖动定位，键盘语义由 role=slider 提供
    <div
      data-canvas-selectable
      role="slider"
      tabIndex={0}
      aria-label="audio"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(playedRatio * 100)}
      className="relative flex h-12 w-full cursor-pointer touch-none items-center gap-[2px] px-1"
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        seekAt(event.clientX, event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (!dragging) {
          return;
        }
        seekAt(event.clientX, event.currentTarget);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      onClick={(event) => event.stopPropagation()}
    >
      {peaks.map((peak, index) => (
        <span
          key={index}
          className={cn(
            "flex-1 rounded-sm transition-colors",
            index / peaks.length <= playedRatio ? "bg-fuchsia-500" : "bg-fuchsia-500/35",
          )}
          style={{ height: `${Math.max(8, Math.round(peak * 100))}%` }}
        />
      ))}
    </div>
  );
}

// 参考媒体节点：上传一段参考视频或参考音频，通过出端口接入视频生成节点
export function MediaGraphNodeView({
  node,
  selected,
  compatible,
  handlers,
}: {
  node: MediaGraphNode;
  selected: boolean;
  compatible: boolean;
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const mediaRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  // 记录按下位置：拖动节点后不误触悬浮工具栏
  const pressRef = React.useRef<{ x: number; y: number } | null>(null);
  // 播放控制条：点击素材后显示时长、进度、静音与全屏
  const [controlsOpen, setControlsOpen] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  // 用户通过控制条主动播放后，鼠标移出不再自动暂停
  const [manualPlay, setManualPlay] = React.useState(false);
  // 默认开启声音；自动播放被拦截时降级为静音
  const [muted, setMuted] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const isVideo = node.mediaKind === "video";

  // 悬停自动播放：默认带声音；浏览器拦截有声自动播放时降级为静音播放
  const startPreview = React.useCallback(() => {
    if (controlsOpen || manualPlay) {
      return;
    }
    const media = mediaRef.current;
    if (!media) return;
    media.muted = muted;
    media.volume = 1;
    void media.play().catch(() => {
      media.muted = true;
      setMuted(true);
      void media.play().catch(() => {});
    });
  }, [controlsOpen, manualPlay, muted]);
  const stopPreview = React.useCallback(() => {
    if (manualPlay) {
      return;
    }
    const media = mediaRef.current;
    if (media) {
      media.pause();
      media.currentTime = 0;
      setPlaying(false);
    }
  }, [manualPlay]);

  // 播放控制条按钮：播放 / 暂停、静音、全屏
  const togglePlayback = React.useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) {
      setManualPlay(true);
      void media.play().catch(() => undefined);
    } else {
      setManualPlay(false);
      media.pause();
    }
  }, []);
  const toggleMuted = React.useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    const next = !media.muted;
    media.muted = next;
    setMuted(next);
  }, []);
  const enterFullscreen = React.useCallback(() => {
    // 全屏节点预览容器而不是 video 本身，保证自定义控制条在全屏下仍可操作
    setControlsOpen(true);
    void previewRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  // 点击控制条与素材节点以外的位置时关闭控制条
  React.useEffect(() => {
    if (!controlsOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest("[data-media-controls]") || target.closest(`[data-canvas-node-id="${node.id}"]`)) {
        return;
      }
      setControlsOpen(false);
      setManualPlay(false);
      const media = mediaRef.current;
      if (media) {
        media.pause();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [controlsOpen, node.id]);

  // 预览缺失（刷新恢复、跨节点拖入）时按 fileID 拉取
  React.useEffect(() => {
    if (node.reference && !node.previewURL) {
      handlers.onEnsureNodePreview(node.id);
    }
  }, [handlers, node.id, node.previewURL, node.reference]);

  const handleFile = React.useCallback(
    async (file: File) => {
      if (!file.type.startsWith(isVideo ? "video/" : "audio/")) {
        toast.error(isVideo ? t("referenceNotVideo") : t("referenceNotAudio"));
        return;
      }
      handlers.onUpdateNode(node.id, { uploading: true });
      const uploaded = await handlers.uploadReferenceFile(file);
      handlers.onUpdateNode(node.id, {
        reference: uploaded
          ? {
            fileID: uploaded.fileID,
            fileName: uploaded.fileName,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
          }
          : null,
        uploading: false,
        previewURL: uploaded?.previewURL,
      });
    },
    [handlers, isVideo, node.id, t],
  );

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      const expected = isVideo ? "video/" : "audio/";
      if (!Array.from(event.dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith(expected))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: React.DragEvent) => {
      const file = event.dataTransfer.files[0];
      if (file) {
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        void handleFile(file);
      }
    },
  };

  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="media"
      title={isVideo ? t("nodeKindMediaVideo") : t("nodeKindMediaAudio")}
      icon={isVideo
        ? <Video className="size-3.5 shrink-0 text-fuchsia-500" strokeWidth={1.8} />
        : <AudioLines className="size-3.5 shrink-0 text-fuchsia-500" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
      bare
    >
      <div className="flex size-full flex-col overflow-hidden rounded-xl bg-muted/20">
        <input
          ref={inputRef}
          type="file"
          accept={isVideo ? "video/*" : "audio/*"}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) {
              void handleFile(file);
            }
          }}
        />
        <div
          ref={previewRef}
          {...dropProps}
          {...(node.reference ? { role: "button", tabIndex: 0, "aria-label": t("assetActions") } : {})}
          onMouseEnter={startPreview}
          onMouseLeave={stopPreview}
          onPointerDown={(event) => {
            pressRef.current = { x: event.clientX, y: event.clientY };
          }}
          onClick={(event) => {
            event.stopPropagation();
            const press = pressRef.current;
            pressRef.current = null;
            if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
              return;
            }
            if (node.reference) {
              setControlsOpen(true);
              handlers.onOpenAssetToolbar(node);
            }
          }}
          onKeyDown={(event) => {
            if (node.reference && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              event.stopPropagation();
              handlers.onOpenAssetToolbar(node);
            }
          }}
          className={cn(
            "relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-muted/20 p-2 text-center transition-colors",
            dragOver && "bg-fuchsia-500/10 ring-2 ring-fuchsia-500/40",
          )}
        >
          {node.uploading ? (
            <span className="size-5 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
          ) : node.reference ? (
            <>
              {node.previewURL ? (
                isVideo ? (
                  <video
                    ref={mediaRef as React.RefObject<HTMLVideoElement | null>}
                    src={node.previewURL}
                    muted={muted}
                    playsInline
                    preload="metadata"
                    draggable={false}
                    className="pointer-events-none size-full rounded-md object-contain"
                    onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                  />
                ) : (
                  <>
                    {/* biome-ignore lint/a11y/useMediaCaption: 音频素材无字幕轨道，隐藏播放器仅用于时间轴 */}
                    <audio
                      ref={mediaRef as React.RefObject<HTMLAudioElement | null>}
                      src={node.previewURL}
                      className="hidden"
                      onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                    />
                    <AudioWaveform
                      source={node.previewURL}
                      progress={duration > 0 ? currentTime / duration : 0}
                      onSeek={(ratio) => {
                        const media = mediaRef.current;
                        if (!media || duration <= 0) {
                          return;
                        }
                        const next = ratio * duration;
                        media.currentTime = next;
                        setCurrentTime(next);
                        if (media.paused) {
                          void media.play().catch(() => undefined);
                        }
                      }}
                    />
                  </>
                )
              ) : (
                <div className="flex flex-col items-center gap-1 px-2">
                  {isVideo
                    ? <Video className="size-5 text-muted-foreground" strokeWidth={1.6} />
                    : <AudioLines className="size-5 text-muted-foreground" strokeWidth={1.6} />}
                  <p className="w-full truncate text-[11px] text-muted-foreground">{node.reference.fileName}</p>
                </div>
              )}
              {!isVideo && node.previewURL ? (
                <span className="flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
                  <AudioLines className="size-3" strokeWidth={1.8} />
                  {formatMediaClock(currentTime)} / {formatMediaClock(duration)}
                </span>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              data-canvas-selectable
              className="flex flex-col items-center gap-1.5 rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                inputRef.current?.click();
              }}
            >
              <Upload className="size-4" strokeWidth={1.8} />
              <span className="text-[11px]">{isVideo ? t("mediaUploadVideo") : t("mediaUploadAudio")}</span>
            </button>
          )}
          {isVideo && node.reference && node.previewURL && controlsOpen ? (
            // biome-ignore lint/a11y/useKeyWithClickEvents: 容器仅拦截点击冒泡，交互由内部按钮承担
            <div
              data-media-controls
              data-canvas-selectable
              className="absolute inset-x-1 bottom-1 flex items-center gap-1 rounded-lg bg-background/90 px-1.5 py-1 shadow-sm backdrop-blur"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                aria-label={playing ? "pause" : "play"}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/85 transition-colors hover:bg-accent"
                onClick={togglePlayback}
              >
                {playing ? <Pause className="size-3.5" strokeWidth={1.8} /> : <Play className="size-3.5" strokeWidth={1.8} />}
              </button>
              <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
                {formatMediaClock(currentTime)}/{formatMediaClock(duration)}
              </span>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(currentTime, duration || 0)}
                aria-label={t("assetActions")}
                className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-foreground/15 accent-primary"
                onChange={(event) => {
                  const media = mediaRef.current;
                  const next = Number(event.target.value);
                  if (media) {
                    media.currentTime = next;
                  }
                  setCurrentTime(next);
                }}
              />
              <button
                type="button"
                aria-label={muted ? "unmute" : "mute"}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={toggleMuted}
              >
                {muted ? <VolumeX className="size-3.5" strokeWidth={1.8} /> : <Volume2 className="size-3.5" strokeWidth={1.8} />}
              </button>
              {isVideo ? (
                <button
                  type="button"
                  aria-label={t("timelineFullscreen")}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={enterFullscreen}
                >
                  <Maximize2 className="size-3.5" strokeWidth={1.8} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {node.reference ? (
          <AssetNameBar
            kind={isVideo ? "video" : "audio"}
            name={node.reference.fileName}
            onRename={(next) => handlers.onUpdateNode(node.id, {
              reference: node.reference ? { ...node.reference, fileName: next } : null,
            })}
            className="shrink-0 pt-1"
          />
        ) : null}
      </div>
    </GraphNodeShell>
  );
}
