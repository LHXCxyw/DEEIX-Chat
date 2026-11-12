"use client";

import { AudioLines, Download, Film, Loader2, Maximize2, Pause, Play, Plus, Redo2, Scissors, Trash2, Undo2, Volume2, VolumeX, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GraphNodeShell } from "@/features/canvas/components/canvas-graph-node-shell";
import type { GraphNodeActionHandlers } from "@/features/canvas/components/canvas-graph-nodes";
import {
  DEFAULT_TIMELINE_TRACKS,
  graphNodeSize,
  type TimelineGraphNode,
  type TimelineSegment,
  type TimelineTrackDef,
  type TimelineTrackKind,
} from "@/features/canvas/model/canvas-types";
import { cn } from "@/lib/utils";

// 时间线片段的来源信息：由视口按连线解析后传入
export type TimelineSourceInfo = {
  segmentID: string;
  sourceNodeID: string;
  track: string;
  name: string;
  previewURL?: string;
};

// 可接入时间线的素材来源（用于片段末尾的 + 按钮）
export type TimelineAttachOption = {
  nodeID: string;
  name: string;
  previewURL?: string;
  track: TimelineTrackKind;
};

// 每秒像素：决定时间轴与素材宽度，时间与像素严格线性对应
const PX_PER_SECOND = 32;

// 轨道内片段的布局结果：start/end 为时间线秒数
type TimelineEntry = { segment: TimelineSegment; start: number; duration: number; end: number };

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}

function buildTicks(span: number): number[] {
  const step = span <= 60 ? 5 : span <= 180 ? 10 : 30;
  const ticks: number[] = [];
  for (let value = 0; value <= span; value += step) {
    ticks.push(value);
  }
  if (ticks[ticks.length - 1] !== span) {
    ticks.push(span);
  }
  return ticks;
}

// 时间线节点：视频/音频双轨剪辑面板，支持分割、删除、预览播放、拖拽排序与导出拼接
export function TimelineGraphNodeView({
  node,
  selected,
  compatible,
  sources,
  availableSources = [],
  handlers,
}: {
  node: TimelineGraphNode;
  selected: boolean;
  compatible: boolean;
  sources: TimelineSourceInfo[];
  availableSources?: TimelineAttachOption[];
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const [durations, setDurations] = React.useState<Record<string, number>>({});
  const [selectedSegmentID, setSelectedSegmentID] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  const [scrubbing, setScrubbing] = React.useState(false);
  const [playhead, setPlayhead] = React.useState(0);
  const [hoverTime, setHoverTime] = React.useState<number | null>(null);
  const [previewSourceID, setPreviewSourceID] = React.useState<string | null>(null);
  // 片段拖动：拖到的轨道与时间线起点（松手后提交）
  const [dragState, setDragState] = React.useState<{ segmentID: string; trackID: string; start: number } | null>(null);
  const dragRef = React.useRef<{
    segmentID: string;
    startClientX: number;
    originStart: number;
    originTrackID: string;
    rowWidth: number;
    span: number;
    active: boolean;
  } | null>(null);
  // 全屏编辑的预览模式：默认按时间线顺序播放全部素材
  const [sequenceMode, setSequenceMode] = React.useState(true);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  // 播放器在节点预览与全屏对话框之间切换时，旧元素的卸载不能清空新元素的引用
  const setVideoElement = React.useCallback((element: HTMLVideoElement | null) => {
    if (!element) {
      return;
    }
    videoRef.current = element;
    return () => {
      if (videoRef.current === element) {
        videoRef.current = null;
      }
    };
  }, []);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const previewRef = React.useRef<HTMLVideoElement | null>(null);
  const videoIndexRef = React.useRef(0);
  const audioIndexRef = React.useRef(0);
  const videoDoneRef = React.useRef(false);
  const audioDoneRef = React.useRef(false);
  // 播放态镜像：预览 seek 触发的 timeupdate 不能推动播放头
  const playingRef = React.useRef(false);
  // 播放令牌：停止播放时递增，取消等待元信息后自动播放的回调
  const playbackTokenRef = React.useRef(0);

  const sourceByID = React.useMemo(
    () => new Map(sources.map((item) => [item.sourceNodeID, item])),
    [sources],
  );
  // 轨道列表：旧数据缺省为内置视频轨 + 音频轨
  const tracks = React.useMemo<TimelineTrackDef[]>(
    () => (node.tracks && node.tracks.length > 0 ? node.tracks : DEFAULT_TIMELINE_TRACKS),
    [node.tracks],
  );
  const primaryVideoTrack = tracks.find((track) => track.kind === "video") ?? DEFAULT_TIMELINE_TRACKS[0];
  const primaryAudioTrack = tracks.find((track) => track.kind === "audio") ?? null;
  const durationOf = (segment: TimelineSegment): number => {
    if (segment.end > segment.start) {
      return segment.end - segment.start;
    }
    return durations[segment.id] ?? 0;
  };
  const startOf = (segment: TimelineSegment): number => (segment.end > segment.start ? segment.start : 0);
  // 轨道布局：按数组顺序累计位置，显式 timelineStart 优先；缺省片段紧跟前一个（不会被挤到末尾）
  const layoutEntries = (segments: TimelineSegment[], trackID: string): TimelineEntry[] => {
    const entries: TimelineEntry[] = [];
    let cursor = 0;
    for (const segment of segments) {
      if ((segment.track ?? "video") !== trackID) {
        continue;
      }
      const start = Math.max(0, segment.timelineStart ?? cursor);
      const duration = durationOf(segment);
      entries.push({ segment, start, duration, end: start + duration });
      cursor = Math.max(cursor, start + duration);
    }
    // 渲染与播放按实际起点排序（拖动后数组顺序可能与时间顺序不一致）
    return entries.sort((a, b) => a.start - b.start);
  };
  const layoutOf = (trackID: string) => layoutEntries(node.segments, trackID);
  // 播放与导出都使用主视频轨/主音频轨，其余轨道用于整理素材
  const videoEntries = layoutOf(primaryVideoTrack.id);
  const audioEntries = primaryAudioTrack ? layoutOf(primaryAudioTrack.id) : [];
  const videoSegments = videoEntries.map((entry) => entry.segment);
  const trackDuration = (trackID: string) =>
    layoutOf(trackID).reduce((max, entry) => Math.max(max, entry.end), 0);
  const totalDuration = tracks.reduce((max, track) => Math.max(max, trackDuration(track.id)), 0);
  // 节点视图默认只显示节点宽度对应的时间长度，素材变长后自动扩展
  const [nodeAreaWidth, setNodeAreaWidth] = React.useState(0);
  const nodeObserverRef = React.useRef<ResizeObserver | null>(null);
  const measureNodeArea = React.useCallback((element: HTMLDivElement | null) => {
    nodeObserverRef.current?.disconnect();
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) {
        setNodeAreaWidth(Math.round(width));
      }
    });
    observer.observe(element);
    nodeObserverRef.current = observer;
  }, []);
  React.useEffect(() => () => nodeObserverRef.current?.disconnect(), []);
  const nodeTimelineWidth = Math.max(320, nodeAreaWidth > 0 ? nodeAreaWidth - 64 : 648);
  const spanOf = (fullscreen: boolean) => {
    const total = Math.max(1, totalDuration);
    if (fullscreen) {
      return Math.max(5, Math.ceil(total / 5) * 5);
    }
    return Math.max(Math.max(5, nodeTimelineWidth / PX_PER_SECOND), Math.ceil(total * 10) / 10);
  };
  // 全屏时间轴按可用宽度铺满（而非固定 32px/s 只占一半）；宽度不足时再横向滚动
  const [fullscreenWidth, setFullscreenWidth] = React.useState(0);
  const fullscreenObserverRef = React.useRef<ResizeObserver | null>(null);
  const measureFullscreen = React.useCallback((element: HTMLDivElement | null) => {
    fullscreenObserverRef.current?.disconnect();
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) {
        setFullscreenWidth(Math.round(width));
      }
    });
    observer.observe(element);
    fullscreenObserverRef.current = observer;
  }, []);
  React.useEffect(() => () => fullscreenObserverRef.current?.disconnect(), []);
  const contentWidthOf = (fullscreen: boolean) => {
    const span = spanOf(fullscreen);
    if (!fullscreen) {
      return Math.max(nodeTimelineWidth, span * PX_PER_SECOND);
    }
    const available = Math.max(320, fullscreenWidth - 68);
    return Math.max(available, span * PX_PER_SECOND);
  };
  const pxOf = (fullscreen: boolean) => contentWidthOf(fullscreen) / Math.max(1, spanOf(fullscreen));
  const muted = node.mutedTracks ?? {};
  const selectedSegment = node.segments.find((segment) => segment.id === selectedSegmentID) ?? null;
  const previewSource = (() => {
    const sourceID = previewSourceID ?? selectedSegment?.sourceNodeID ?? node.segments[0]?.sourceNodeID;
    return sourceID ? sourceByID.get(sourceID) ?? null : null;
  })();
  const uniqueSources = React.useMemo(() => {
    const seen = new Set<string>();
    const list: TimelineSourceInfo[] = [];
    for (const source of sources) {
      if (seen.has(source.sourceNodeID)) {
        continue;
      }
      seen.add(source.sourceNodeID);
      list.push(source);
    }
    return list;
  }, [sources]);

  // 轨道序号文案：视频轨 1 / 音频轨 2
  const trackLabel = (track: TimelineTrackDef): string => {
    const sameKind = tracks.filter((item) => item.kind === track.kind);
    const index = sameKind.findIndex((item) => item.id === track.id) + 1;
    return `${track.kind === "audio" ? t("timelineAudioTrack") : t("timelineVideoTrack")} ${index}`;
  };

  // 新增轨道：同名轨道按序号递增，避免与内置轨冲突
  const addTrack = (kind: TimelineTrackKind) => {
    let index = 2;
    while (tracks.some((track) => track.id === `${kind}-${index}`)) {
      index += 1;
    }
    handlers.onUpdateNode(node.id, { tracks: [...tracks, { id: `${kind}-${index}`, kind }] });
  };

  // 删除自定义轨道：连同该轨片段一起移除
  const removeTrack = (trackID: string) => {
    if (trackID === "video" || trackID === "audio") {
      return;
    }
    handlers.onUpdateNode(node.id, {
      tracks: tracks.filter((track) => track.id !== trackID),
      segments: node.segments.filter((segment) => (segment.track ?? "video") !== trackID),
    });
  };

  const toggleTrackMute = (trackID: string) => {
    handlers.onUpdateNode(node.id, { mutedTracks: { ...muted, [trackID]: !muted[trackID] } });
  };

  // 播放中切换静音立即生效
  React.useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted[primaryVideoTrack.id] === true;
    }
    if (audioRef.current) {
      audioRef.current.muted = primaryAudioTrack ? muted[primaryAudioTrack.id] === true : false;
    }
  }, [muted, playing, primaryAudioTrack, primaryVideoTrack.id]);

  // 播放状态镜像：供原生事件回调判断是否处于播放中
  React.useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // 播放状态同步到节点数据：视口据此把时间线提到最上层，预览不被其他节点遮挡
  const setPlayingState = React.useCallback((next: boolean) => {
    // 同步镜像，避免原生 pause 事件在状态提交前误判为「意外暂停」而自动恢复播放
    playingRef.current = next;
    setPlaying(next);
    handlers.onUpdateNode(node.id, { playing: next });
  }, [handlers, node.id]);

  const stopPlayback = React.useCallback(() => {
    // 递增令牌：取消仍在等待元信息、准备自动播放的回调
    playbackTokenRef.current += 1;
    // 只暂停不卸载源：保留当前帧，避免暂停后预览区域变成黑屏
    const video = videoRef.current;
    if (video) {
      video.pause();
    }
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
    }
    setPlayingState(false);
    setScrubbing(false);
    videoIndexRef.current = 0;
    audioIndexRef.current = 0;
    videoDoneRef.current = false;
    audioDoneRef.current = false;
  }, [setPlayingState]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: startOf 为渲染期派生函数，随来源列表更新即可
  const startElement = React.useCallback((
    element: HTMLVideoElement | HTMLAudioElement | null,
    segment: TimelineSegment,
    offset: number,
    mutedTrack: boolean,
  ) => {
    if (!element) {
      return;
    }
    const source = sourceByID.get(segment.sourceNodeID)?.previewURL;
    if (!source) {
      return;
    }
    element.muted = mutedTrack;
    element.src = source;
    element.load();
    const token = playbackTokenRef.current;
    const seekAndPlay = () => {
      try {
        element.currentTime = startOf(segment) + offset;
      } catch {
        // 元信息未就绪时从头播放
      }
      // 等待元信息期间用户可能已停止播放
      if (playbackTokenRef.current !== token) {
        return;
      }
      void element.play().catch(() => undefined);
    };
    if (element.readyState >= 1) {
      seekAndPlay();
    } else {
      element.onloadedmetadata = seekAndPlay;
    }
  }, [sourceByID]);

  // 命中时间线位置：优先返回覆盖该时刻的片段，否则返回起点最近的下一个片段
  const pickEntry = (entries: TimelineEntry[], seconds: number): { entry: TimelineEntry; index: number } | null => {
    let hit: { entry: TimelineEntry; index: number } | null = null;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (seconds >= entry.start && seconds < entry.end) {
        if (!hit || entry.start > hit.entry.start) {
          hit = { entry, index };
        }
      }
    }
    if (hit) {
      return hit;
    }
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index].start >= seconds) {
        return { entry: entries[index], index };
      }
    }
    return null;
  };

  // 从指定秒数开始播放：按时间线位置定位到主视频轨 / 主音频轨的片段
  const startPlaybackAt = (seconds: number) => {
    playbackTokenRef.current += 1;
    const videoHit = pickEntry(videoEntries, seconds);
    const audioHit = pickEntry(audioEntries, seconds);
    // 源文件没有可播放地址时视为该轨已结束，避免只有声音没有画面
    const videoPlayable = Boolean(videoHit && sourceByID.get(videoHit.entry.segment.sourceNodeID)?.previewURL);
    const audioPlayable = Boolean(audioHit && sourceByID.get(audioHit.entry.segment.sourceNodeID)?.previewURL);
    videoDoneRef.current = !videoPlayable;
    audioDoneRef.current = !audioPlayable;
    if (!videoPlayable && !audioPlayable) {
      setPlayingState(false);
      return;
    }
    if (videoHit && videoPlayable) {
      videoIndexRef.current = videoHit.index;
      startElement(videoRef.current, videoHit.entry.segment, Math.max(0, seconds - videoHit.entry.start), muted[primaryVideoTrack.id] === true);
    }
    if (audioHit && audioPlayable) {
      audioIndexRef.current = audioHit.index;
      startElement(audioRef.current, audioHit.entry.segment, Math.max(0, seconds - audioHit.entry.start), primaryAudioTrack ? muted[primaryAudioTrack.id] === true : false);
    }
    setPlayingState(true);
    setPlayhead(seconds);
    ensurePlaying();
  };

  // 播放兜底：切换全屏 / 元信息未就绪时 play() 可能被忽略，短时间内自动重试
  const ensurePlaying = (attempt = 0) => {
    window.setTimeout(() => {
      if (!playingRef.current) {
        return;
      }
      const video = videoRef.current;
      if (video?.paused && !video.ended && video.readyState >= 2) {
        void video.play().catch(() => undefined);
      }
      const audio = audioRef.current;
      if (audio?.paused && !audio.ended && audio.readyState >= 2) {
        void audio.play().catch(() => undefined);
      }
      if (attempt < 2) {
        ensurePlaying(attempt + 1);
      }
    }, attempt === 0 ? 200 : 500);
  };

  const maybeFinish = () => {
    if (videoDoneRef.current && audioDoneRef.current) {
      setPlayingState(false);
    }
  };

  const advanceVideo = () => {
    // 预览 seek 也可能触发 ended，只有播放中才推进片段
    if (!playingRef.current) {
      return;
    }
    const next = videoIndexRef.current + 1;
    if (next >= videoEntries.length) {
      videoDoneRef.current = true;
      maybeFinish();
      return;
    }
    const current = videoEntries[videoIndexRef.current];
    const nextEntry = videoEntries[next];
    videoIndexRef.current = next;
    // 同一源且时间线紧邻（分割后的相邻片段）时不重新加载，避免接缝处重复播放
    const contiguous = nextEntry.segment.sourceNodeID === current.segment.sourceNodeID
      && Math.abs(startOf(nextEntry.segment) - (startOf(current.segment) + current.duration)) < 0.08
      && Math.abs(nextEntry.start - current.end) < 0.08;
    if (!contiguous) {
      startElement(videoRef.current, nextEntry.segment, 0, muted[primaryVideoTrack.id] === true);
    }
    setPlayhead(nextEntry.start);
  };

  const advanceAudio = () => {
    // 预览 seek 也可能触发 ended，只有播放中才推进片段
    if (!playingRef.current) {
      return;
    }
    const next = audioIndexRef.current + 1;
    if (next >= audioEntries.length) {
      audioDoneRef.current = true;
      maybeFinish();
      return;
    }
    const current = audioEntries[audioIndexRef.current];
    const nextEntry = audioEntries[next];
    audioIndexRef.current = next;
    const contiguous = nextEntry.segment.sourceNodeID === current.segment.sourceNodeID
      && Math.abs(startOf(nextEntry.segment) - (startOf(current.segment) + current.duration)) < 0.08
      && Math.abs(nextEntry.start - current.end) < 0.08;
    if (!contiguous) {
      startElement(audioRef.current, nextEntry.segment, 0, primaryAudioTrack ? muted[primaryAudioTrack.id] === true : false);
    }
  };

  const handleVideoProgress = () => {
    // 悬停/拖动预览会 seek 预览视频，其 timeupdate 不能推动播放头
    if (!playingRef.current) {
      return;
    }
    const element = videoRef.current;
    const entry = videoEntries[videoIndexRef.current];
    if (!element || !entry) {
      return;
    }
    const local = Math.max(0, element.currentTime - startOf(entry.segment));
    setPlayhead(entry.start + local);
    if (entry.duration > 0 && local >= entry.duration - 0.02) {
      advanceVideo();
    }
  };

  const handleAudioProgress = () => {
    // 仅播放中同步音频轨时间，预览 seek 不参与
    if (!playingRef.current) {
      return;
    }
    const element = audioRef.current;
    const entry = audioEntries[audioIndexRef.current];
    if (!element || !entry) {
      return;
    }
    const local = Math.max(0, element.currentTime - startOf(entry.segment));
    // 没有视频轨时由音频轨驱动播放头
    if (videoEntries.length === 0) {
      setPlayhead(entry.start + local);
    }
    if (entry.duration > 0 && local >= entry.duration - 0.02) {
      advanceAudio();
    }
  };

  const togglePlayback = () => {
    if (playing) {
      stopPlayback();
      return;
    }
    if (videoEntries.length === 0 && audioEntries.length === 0) {
      return;
    }
    // 从当前播放头开始播放，而不是每次都从头
    startPlaybackAt(playhead >= totalDuration ? 0 : playhead);
  };

  // 把预览画面定位到指定秒数（暂停状态），用于拖动与悬停预览；悬停时限频避免频繁 seek
  const lastPreviewRef = React.useRef(0);
  const previewFrameAt = (seconds: number, force = false) => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!force && now - lastPreviewRef.current < 80) {
      return;
    }
    lastPreviewRef.current = now;
    const video = videoRef.current;
    if (!video || videoEntries.length === 0) {
      return;
    }
    const hit = pickEntry(videoEntries, seconds);
    if (!hit) {
      return;
    }
    const source = sourceByID.get(hit.entry.segment.sourceNodeID)?.previewURL;
    if (!source) {
      return;
    }
    const target = startOf(hit.entry.segment) + Math.max(0, seconds - hit.entry.start);
    const seek = () => {
      try {
        video.currentTime = target;
      } catch {
        // 忽略定位失败
      }
    };
    video.pause();
    if (video.src !== source) {
      // 首次加载或切换素材：等元信息就绪后再定位，否则会停在黑帧
      video.src = source;
      video.load();
      video.onloadedmetadata = seek;
    } else if (video.readyState >= 1) {
      seek();
    } else {
      video.onloadedmetadata = seek;
    }
  };

  // 进入 / 退出全屏、切换成片与单素材时，把画面重新定位到当前播放头，避免黑屏
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在模式切换时补一帧
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => previewFrameAt(playhead, true));
    return () => cancelAnimationFrame(frame);
  }, [expanded, sequenceMode]);

  // 画布缩放后 getBoundingClientRect 返回屏幕像素：按内容宽度比例换算回画布内部时间
  const secondsFromClientX = (clientX: number, element: HTMLElement, fullscreen: boolean): number => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) {
      return 0;
    }
    const offsetX = ((clientX - rect.left) / rect.width) * contentWidthOf(fullscreen);
    return Math.min(Math.max(0, offsetX / pxOf(fullscreen)), spanOf(fullscreen));
  };

  // 点击/拖动时间轴只定位播放头，不切分素材；播放中先停止播放
  const seekFromClientX = (clientX: number, element: HTMLElement, withPreview: boolean, fullscreen: boolean) => {
    const seconds = secondsFromClientX(clientX, element, fullscreen);
    setPlayhead(seconds);
    if (withPreview) {
      previewFrameAt(seconds, true);
    }
    return seconds;
  };

  // 选中片段在时间线上的位置（用于分割判定与源内秒数换算）
  const selectedEntry = (() => {
    if (!selectedSegment) {
      return null;
    }
    const trackID = selectedSegment.track ?? "video";
    return layoutOf(trackID).find((entry) => entry.segment.id === selectedSegment.id) ?? null;
  })();
  // 分割线落在选中片段内才允许分割
  const canSplitSelected = Boolean(selectedEntry && playhead > selectedEntry.start + 0.05 && playhead < selectedEntry.end - 0.05);
  // 未选中素材时：分割线落在任意片段内即可按轨道整体分割
  const anySegmentAtPlayhead = tracks.some((track) =>
    layoutOf(track.id).some((entry) => playhead > entry.start + 0.05 && playhead < entry.end - 0.05));
  const splitEnabled = selectedSegment ? canSplitSelected : anySegmentAtPlayhead;

  const splitAtPlayhead = () => {
    if (selectedSegment && selectedEntry) {
      if (playhead <= selectedEntry.start || playhead >= selectedEntry.end) {
        return;
      }
      // 播放头是时间线秒数：换算成该片段在源视频中的秒数
      const sourceAt = startOf(selectedSegment) + (playhead - selectedEntry.start);
      handlers.onSplitTimelineSegment(node.id, selectedSegment.id, sourceAt, selectedEntry.duration, playhead);
      return;
    }
    // 未选中素材：在所有轨道上按分割线位置切开
    const layout: Record<string, { offset: number; duration: number }> = {};
    for (const track of tracks) {
      for (const entry of layoutOf(track.id)) {
        layout[entry.segment.id] = { offset: entry.start, duration: entry.duration };
      }
    }
    handlers.onSplitTimelineAt(node.id, playhead, layout);
  };

  // 把每个片段的时间线起点固化为显式 timelineStart，拖动后其余片段保持原位
  const normalizedSegments = (): TimelineSegment[] => {
    const starts = new Map<string, number>();
    for (const track of tracks) {
      for (const entry of layoutOf(track.id)) {
        starts.set(entry.segment.id, entry.start);
      }
    }
    return node.segments.map((segment) => starts.has(segment.id)
      ? { ...segment, timelineStart: starts.get(segment.id) }
      : segment);
  };

  const renderToolbar = (fullscreen: boolean) => (
    <div className="flex shrink-0 items-center gap-0.5 px-0.5">
      <button
        type="button"
        aria-label={t("timelineSplit")}
        title={t("timelineSplit")}
        disabled={!splitEnabled}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        onClick={splitAtPlayhead}
      >
        <Scissors className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        aria-label={t("timelineUndo")}
        title={t("timelineUndo")}
        disabled={!handlers.canUndo}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        onClick={handlers.onUndo}
      >
        <Undo2 className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        aria-label={t("timelineRedo")}
        title={t("timelineRedo")}
        disabled={!handlers.canRedo}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        onClick={handlers.onRedo}
      >
        <Redo2 className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        aria-label={t("timelineRemoveSegment")}
        title={t("timelineRemoveSegment")}
        disabled={!selectedSegment}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
        onClick={() => {
          if (selectedSegment) {
            handlers.onRemoveTimelineSegment(node.id, selectedSegment.id);
            setSelectedSegmentID(null);
          }
        }}
      >
        <Trash2 className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
      </button>
      <span className="mx-1 h-4 w-px bg-border/60" />
      <button
        type="button"
        aria-label={playing ? t("timelinePause") : t("timelinePlay")}
        title={playing ? t("timelinePause") : t("timelinePlay")}
        className="flex size-7 items-center justify-center rounded-md text-foreground/85 transition-colors hover:bg-accent"
        onClick={() => {
          if (fullscreen && !sequenceMode) {
            // 单素材预览：由大画面预览自己播放
            const video = previewRef.current;
            if (video) {
              if (video.paused) {
                void video.play().catch(() => undefined);
              } else {
                video.pause();
              }
              return;
            }
            // 音频素材没有画面：切回成片预览播放
            setSequenceMode(true);
          }
          togglePlayback();
        }}
      >
        {playing
          ? <Pause className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
          : <Play className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />}
      </button>
      <span className="ml-1 text-[11px] tabular-nums text-foreground/85">
        {formatClock(playhead)} <span className="text-muted-foreground">/ {formatClock(totalDuration)}</span>
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-canvas-selectable
            aria-label={t("timelineAddTrack")}
            title={t("timelineAddTrack")}
            className="ml-0.5 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Plus className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
          </button>
        </PopoverTrigger>
        <PopoverContent data-canvas-ui="timeline-track-menu" align="start" side="bottom" className="w-48 p-1.5">
          <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("timelineAddTrack")}
          </p>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent"
            onClick={() => addTrack("video")}
          >
            <Film className="size-3.5 shrink-0 text-cyan-500" strokeWidth={1.8} />
            {t("timelineAddVideoTrack")}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent"
            onClick={() => addTrack("audio")}
          >
            <AudioLines className="size-3.5 shrink-0 text-fuchsia-500" strokeWidth={1.8} />
            {t("timelineAddAudioTrack")}
          </button>
        </PopoverContent>
      </Popover>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          aria-label={t("timelineExport")}
          title={t("timelineExport")}
          disabled={node.exporting || videoSegments.length === 0}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={() => handlers.onExportTimeline(node.id)}
        >
          {node.exporting
            ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            : <Download className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />}
        </button>
        <button
          type="button"
          aria-label={t("timelineFullscreen")}
          title={t("timelineFullscreen")}
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => {
            setPreviewSourceID(selectedSegment?.sourceNodeID ?? videoSegments[0]?.sourceNodeID ?? null);
            // 打开全屏默认展示「全部素材」成片预览
            setSequenceMode(true);
            setExpanded(true);
          }}
        >
          <Maximize2 className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
          {t("timelineFullscreen")}
        </button>
      </div>
    </div>
  );

  // 片段拖动：按下记录起点，移动超过阈值后进入拖动，松手提交到目标轨道与时间位置
  const beginClipDrag = (event: React.PointerEvent<HTMLElement>, entry: TimelineEntry, trackID: string, fullscreen: boolean) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    setHoverTime(null);
    const row = event.currentTarget.closest("[data-timeline-track-id]") as HTMLElement | null;
    dragRef.current = {
      segmentID: entry.segment.id,
      startClientX: event.clientX,
      originStart: entry.start,
      originTrackID: trackID,
      rowWidth: row?.getBoundingClientRect().width ?? contentWidthOf(fullscreen),
      span: spanOf(fullscreen),
      active: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveClipDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    event.stopPropagation();
    const dx = event.clientX - drag.startClientX;
    if (!drag.active) {
      if (Math.abs(dx) < 4) {
        return;
      }
      drag.active = true;
    }
    // 行宽对应整条时间轴（span 秒），屏幕位移按比例换算成时间
    const secondsPerPixel = drag.span / Math.max(1, drag.rowWidth);
    const start = Math.max(0, Math.round((drag.originStart + dx * secondsPerPixel) * 10) / 10);
    const segment = node.segments.find((item) => item.id === drag.segmentID);
    const segmentKind = segment ? sourceByID.get(segment.sourceNodeID)?.track ?? "video" : "video";
    const hovered = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest("[data-timeline-track-id]") as HTMLElement | null;
    const hoveredID = hovered?.dataset.timelineTrackId ?? drag.originTrackID;
    const hoveredTrack = tracks.find((item) => item.id === hoveredID);
    // 只允许在同类型轨道之间移动，避免视频片段落到音频轨
    const trackID = hoveredTrack && hoveredTrack.kind === segmentKind ? hoveredID : drag.originTrackID;
    setDragState({ segmentID: drag.segmentID, trackID, start });
  };

  // 提交片段移动：同轨道不允许重叠；落在别的片段前半部分则插入其前，后半部分则贴其尾部，后续片段整体后移
  const moveSegmentTo = (segmentID: string, targetTrackID: string, desiredStart: number) => {
    const moved = node.segments.find((segment) => segment.id === segmentID);
    if (!moved) {
      return;
    }
    const duration = durationOf(moved);
    // 先固化所有片段位置，避免隐式排布在移动后重排
    const base = normalizedSegments();
    const starts = new Map<string, number>(base.map((segment) => [segment.id, Math.max(0, segment.timelineStart ?? 0)]));
    const others = base
      .filter((segment) => segment.id !== segmentID && (segment.track ?? "video") === targetTrackID)
      .map((segment) => ({ id: segment.id, start: starts.get(segment.id) ?? 0, duration: durationOf(segment) }))
      .sort((a, b) => a.start - b.start);
    let insertStart = Math.max(0, Math.round(desiredStart * 10) / 10);
    // 落在其他片段内部：前半插入其前，后半贴其尾部
    const hit = others.find((item) => insertStart > item.start + 0.05 && insertStart < item.start + item.duration - 0.05);
    if (hit) {
      insertStart = insertStart < hit.start + hit.duration / 2 ? hit.start : hit.start + hit.duration;
      insertStart = Math.round(insertStart * 10) / 10;
    }
    // 插入区间与后续片段重叠时，依次向后推
    const shifted = new Map<string, number>();
    let cursor = insertStart + duration;
    for (const item of others) {
      if (item.start + item.duration <= insertStart + 0.05) {
        continue;
      }
      const start = Math.round(Math.max(item.start, cursor) * 10) / 10;
      shifted.set(item.id, start);
      cursor = start + item.duration;
    }
    const next = base.map((segment) => {
      if (segment.id === segmentID) {
        return { ...segment, track: targetTrackID, timelineStart: insertStart };
      }
      const start = shifted.get(segment.id);
      return start === undefined ? segment : { ...segment, timelineStart: start };
    });
    handlers.onUpdateNode(node.id, { segments: next });
  };

  const finishClipDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const pending = dragState;
    setDragState(null);
    if (!drag) {
      return;
    }
    event.stopPropagation();
    if (!drag.active || !pending) {
      // 未产生位移：按点击处理，选中该片段
      const segment = node.segments.find((item) => item.id === drag.segmentID);
      if (segment) {
        setSelectedSegmentID(segment.id);
        setPreviewSourceID(segment.sourceNodeID);
      }
      return;
    }
    moveSegmentTo(pending.segmentID, pending.trackID, pending.start);
    setSelectedSegmentID(pending.segmentID);
  };

  const cancelClipDrag = () => {
    dragRef.current = null;
    setDragState(null);
  };

  const renderTrackRow = (track: TimelineTrackDef, fullscreen: boolean) => {
    const entries = layoutOf(track.id);
    const isAudioTrack = track.kind === "audio";
    const rowHeight = fullscreen ? 56 : 44;
    const px = pxOf(fullscreen);
    const cw = contentWidthOf(fullscreen);
    const draggingSegment = dragState ? node.segments.find((segment) => segment.id === dragState.segmentID) : null;
    return (
      <div
        data-timeline-track-id={track.id}
        className="relative min-w-0 select-none"
        style={{ width: cw, height: rowHeight }}
        onDragOver={(event) => event.preventDefault()}
      >
        {entries.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center rounded-md bg-muted/40 text-center text-[10px] leading-relaxed text-muted-foreground">
            {isAudioTrack ? t("timelineAudioEmpty") : t("timelineEmpty")}
          </p>
        ) : entries.map((entry) => {
          const segment = entry.segment;
          const source = sourceByID.get(segment.sourceNodeID);
          const active = segment.id === selectedSegmentID;
          const moving = dragState?.segmentID === segment.id;
          return (
            <button
              key={segment.id}
              type="button"
              data-canvas-selectable
              title={source?.name ?? t("timelineUnknownSource")}
              className={cn(
                "absolute top-0 touch-none overflow-hidden rounded-md bg-muted/60 text-left transition-shadow",
                active ? "z-10 ring-2 ring-primary/70" : "ring-1 ring-border/50 hover:ring-primary/40",
                moving && "opacity-30",
              )}
              style={{
                left: Math.round(entry.start * px),
                width: Math.max(24, Math.round(entry.duration * px)),
                height: rowHeight,
              }}
              onPointerDown={(event) => beginClipDrag(event, entry, track.id, fullscreen)}
              onPointerMove={moveClipDrag}
              onPointerUp={finishClipDrag}
              onPointerCancel={cancelClipDrag}
            >
              {isAudioTrack ? (
                <>
                  {source?.previewURL ? (
                    // biome-ignore lint/a11y/useMediaCaption: 音频片段仅用于读取时长与预览，无字幕
                    <audio
                      src={source.previewURL}
                      preload="metadata"
                      className="hidden"
                      onLoadedMetadata={(event) => {
                        const total = event.currentTarget.duration;
                        if (Number.isFinite(total) && total > 0) {
                          setDurations((current) => ({ ...current, [segment.id]: total }));
                        }
                      }}
                    />
                  ) : null}
                  <span className="flex size-full items-center justify-center gap-1 text-[10px] text-fuchsia-600">
                    <AudioLines className={cn(fullscreen ? "size-5" : "size-4")} strokeWidth={1.8} />
                    <span className="max-w-[70%] truncate">{source?.name ?? t("timelineUnknownSource")}</span>
                  </span>
                </>
              ) : source?.previewURL ? (
                <video
                  src={source.previewURL}
                  muted
                  playsInline
                  preload="metadata"
                  className="pointer-events-none size-full object-cover"
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    const total = video.duration;
                    if (Number.isFinite(total) && total > 0) {
                      setDurations((current) => ({ ...current, [segment.id]: total }));
                    }
                    try {
                      video.currentTime = Math.min(startOf(segment) + 0.1, Math.max(0, (video.duration || 0) - 0.1));
                    } catch {
                      // 定位失败时保留首帧
                    }
                  }}
                />
              ) : (
                <span className="flex size-full items-center justify-center text-muted-foreground/60">
                  <Film className={cn(fullscreen ? "size-6" : "size-5")} strokeWidth={1.6} />
                </span>
              )}
              <span className="absolute bottom-0.5 left-1 rounded bg-black/65 px-1 text-[9px] tabular-nums text-white/90">
                {entry.duration > 0 ? formatClock(entry.duration) : t("timelineWholeClip")}
              </span>
            </button>
          );
        })}
        {/* 拖动中的落位预览 */}
        {dragState && draggingSegment && dragState.trackID === track.id ? (
          <div
            className="pointer-events-none absolute top-0 z-20 rounded-md border border-primary bg-primary/20"
            style={{
              left: Math.round(dragState.start * px),
              width: Math.max(24, Math.round(durationOf(draggingSegment) * px)),
              height: rowHeight,
            }}
          />
        ) : null}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-canvas-selectable
              aria-label={t("timelineAddClip")}
              title={t("timelineAddClip")}
              className="absolute top-0 flex w-10 items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/30 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              style={{ left: cw + 4, height: rowHeight }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Plus className={cn(fullscreen ? "size-4" : "size-3.5")} strokeWidth={1.8} />
            </button>
          </PopoverTrigger>
          <PopoverContent data-canvas-ui="timeline-source-menu" align="start" side="bottom" className="w-60 p-1.5">
            <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {trackLabel(track)}
            </p>
            {availableSources.filter((option) => option.track === track.kind).length === 0 ? (
              <p className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">{t("timelineNoSource")}</p>
            ) : availableSources.filter((option) => option.track === track.kind).map((option) => (
              <button
                key={option.nodeID}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent"
                onClick={() => handlers.onAttachTimelineSource(node.id, option.nodeID, option.track, track.id)}
              >
                {isAudioTrack
                  ? <AudioLines className="size-3.5 shrink-0 text-fuchsia-500" strokeWidth={1.8} />
                  : <Film className="size-3.5 shrink-0 text-cyan-500" strokeWidth={1.8} />}
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
    );
  };

  // 左侧固定栏：轨道名与静音，横向滚动时吸附在最左侧
  const renderTrackGutter = (fullscreen: boolean) => (
    <div className={cn("sticky left-0 z-30 flex w-16 shrink-0 flex-col", fullscreen ? "bg-background" : "bg-card")}>
      <div className={cn("shrink-0", fullscreen ? "mt-1 h-6" : "mt-1 h-5")} />
      {tracks.map((track) => {
        const isMuted = muted[track.id] === true;
        const removable = track.id !== "video" && track.id !== "audio";
        return (
          <div key={track.id} className="group/track relative flex flex-col items-center justify-center gap-0.5" style={{ height: fullscreen ? 60 : 48 }}>
            <span className="max-w-full truncate px-1 text-[9px] text-muted-foreground">
              {trackLabel(track)}
            </span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                data-canvas-selectable
                aria-label={isMuted ? t("timelineUnmute") : t("timelineMute")}
                title={isMuted ? t("timelineUnmute") : t("timelineMute")}
                className={cn(
                  "flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent",
                  isMuted ? "text-destructive" : "text-muted-foreground hover:text-foreground",
                )}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleTrackMute(track.id);
                }}
              >
                {isMuted ? <VolumeX className="size-3.5" strokeWidth={1.8} /> : <Volume2 className="size-3.5" strokeWidth={1.8} />}
              </button>
              {removable ? (
                <button
                  type="button"
                  data-canvas-selectable
                  aria-label={t("timelineRemoveTrack")}
                  title={t("timelineRemoveTrack")}
                  className="flex size-5 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/track:opacity-100"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeTrack(track.id);
                  }}
                >
                  <X className="size-3" strokeWidth={2} />
                </button>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );

  // 时间刻度与播放头：内容本身不滚动，横向/纵向滚动交给外层容器
  const renderTimelineArea = (fullscreen: boolean) => {
    const px = pxOf(fullscreen);
    const cw = contentWidthOf(fullscreen);
    const ticks = buildTicks(spanOf(fullscreen));
    return (
      <div
        className="relative flex flex-col"
        style={{ width: cw }}
        onPointerDown={(event) => {
          const element = event.currentTarget;
          element.setPointerCapture?.(event.pointerId);
          // 拖动/点击时间轴时先停止播放，避免与预览 seek 冲突
          if (playing) {
            stopPlayback();
          }
          setSelectedSegmentID(null);
          setScrubbing(true);
          const startX = event.clientX;
          seekFromClientX(startX, element, true, fullscreen);
          const onMove = (moveEvent: PointerEvent) => {
            seekFromClientX(moveEvent.clientX, element, true, fullscreen);
            setHoverTime(null);
          };
          const onUp = (upEvent: PointerEvent) => {
            element.releasePointerCapture?.(upEvent.pointerId);
            element.removeEventListener("pointermove", onMove);
            element.removeEventListener("pointerup", onUp);
            element.removeEventListener("pointercancel", onUp);
            setScrubbing(false);
            // 单击/拖动都只做跳转，不自动分割素材
            seekFromClientX(upEvent.clientX, element, true, fullscreen);
          };
          element.addEventListener("pointermove", onMove);
          element.addEventListener("pointerup", onUp);
          element.addEventListener("pointercancel", onUp);
        }}
        onPointerMove={(event) => {
          if (scrubbing || playing || dragRef.current) {
            return;
          }
          const seconds = secondsFromClientX(event.clientX, event.currentTarget, fullscreen);
          setHoverTime(seconds);
          // 悬停时同时预览该时间点的画面
          previewFrameAt(seconds);
        }}
        onPointerLeave={() => setHoverTime(null)}
      >
        {/* 刻度 */}
        <div className={cn("relative shrink-0 border-y border-border/45", fullscreen ? "h-6" : "h-5")}>
          {ticks.map((tick) => (
            <span
              key={tick}
              className={cn(
                "absolute top-1/2 text-[9px] tabular-nums text-muted-foreground/80",
                // 刻度文字在刻度线居中，与播放头/悬停线严格对齐
                tick === 0 ? "-translate-y-1/2" : "-translate-x-1/2 -translate-y-1/2",
              )}
              style={{ left: tick * px }}
            >
              {formatClock(tick)}
            </span>
          ))}
        </div>
        <div className="relative flex flex-col gap-1 py-1">
          {tracks.map((track) => renderTrackRow(track, fullscreen))}
          {/* 悬停预览线与播放头 */}
          {hoverTime !== null ? (
            <span
              className="pointer-events-none absolute bottom-0 top-0 z-10 w-px border-l border-dashed border-primary/60"
              style={{ left: hoverTime * px }}
            />
          ) : null}
          <span
            className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-primary"
            style={{ left: playhead * px }}
          />
        </div>
      </div>
    );
  };

  const previewVisible = playing || scrubbing || hoverTime !== null;

  // 预览面板：节点靠近画布顶部时会被裁掉，此时改为在节点下方弹出，避免只听到声音看不到画面
  const previewPanelRef = React.useRef<HTMLDivElement | null>(null);
  const [previewBelow, setPreviewBelow] = React.useState(false);
  React.useEffect(() => {
    const panel = previewPanelRef.current;
    const canvas = panel?.closest("[data-canvas-viewport]") as HTMLElement | null;
    if (!panel || !canvas || !previewVisible) {
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    // 上方空间不足时翻到节点下方
    setPreviewBelow(panelRect.top < canvasRect.top + 8);
  }, [previewVisible]);

  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="timeline"
      title={t("nodeKindTimeline")}
      icon={<Film className="size-3.5 shrink-0 text-cyan-500" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
    >
      <div
        className="flex size-full flex-col gap-1 p-1"
        onPointerEnter={() => handlers.onUpdateNode(node.id, { previewing: true })}
        onPointerLeave={() => handlers.onUpdateNode(node.id, { previewing: false })}
      >
        {renderToolbar(false)}
        <div ref={measureNodeArea} className="flex min-h-0 flex-1 items-start overflow-auto">
          {renderTrackGutter(false)}
          {renderTimelineArea(false)}
        </div>
        {node.exportError ? (
          <p className="shrink-0 px-1 text-[10px] leading-relaxed text-destructive">{node.exportError}</p>
        ) : null}
      </div>

      {/* 播放/拖动预览：浮在节点上方，播放时提高节点层级避免被遮挡；全屏编辑时由对话框内的大画面承载同一播放器 */}
      {expanded ? null : (
        <div
          ref={previewPanelRef}
          className={cn(
            "absolute left-0 right-0 overflow-hidden rounded-xl border border-border/60 bg-black shadow-2xl transition-opacity",
            previewBelow ? "top-[calc(100%+0.5rem)]" : "bottom-[calc(100%+2.5rem)] mb-2",
            previewVisible && videoSegments.length > 0 ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          data-canvas-selectable
        >
          {/* biome-ignore lint/a11y/useMediaCaption: 时间线播放预览，无字幕轨道 */}
          <video
            ref={setVideoElement}
            className="max-h-[42vh] w-full object-contain"
            playsInline
            preload="auto"
            onTimeUpdate={handleVideoProgress}
            onEnded={advanceVideo}
          />
        </div>
      )}
      {/* 隐藏音频播放器：与视频轨同步播放音频轨 */}
      {/* biome-ignore lint/a11y/useMediaCaption: 隐藏的音频轨播放器，无字幕轨道 */}
      <audio ref={audioRef} className="hidden" onTimeUpdate={handleAudioProgress} onEnded={advanceAudio} />

      <Dialog open={expanded} onOpenChange={(open) => {
        setExpanded(open);
        // 预览播放器会在节点与对话框之间重新挂载，进入/退出全屏时先停止播放
        stopPlayback();
        if (open) {
          setSequenceMode(true);
        }
      }}>
        <DialogContent
          data-canvas-ui="timeline-editor"
          className="h-[min(92vh,56rem)] w-[min(94vw,92rem)] max-w-none gap-0 overflow-hidden rounded-2xl border-border/60 p-0 sm:max-w-[min(94vw,92rem)]"
        >
          <DialogTitle className="sr-only">{t("nodeKindTimeline")}</DialogTitle>
          <div className="flex h-full min-h-0 flex-col">
            <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
              <Film className="size-4 text-cyan-500" strokeWidth={1.8} />
              <span className="text-xs font-medium">{t("nodeKindTimeline")}</span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={node.exporting || videoSegments.length === 0}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border/60 px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => handlers.onExportTimeline(node.id)}
                >
                  {node.exporting ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} /> : <Download className="size-3.5" strokeWidth={1.8} />}
                  {node.exporting ? t("timelineExporting") : t("timelineExport")}
                </button>
                <button
                  type="button"
                  aria-label={t("timelineCloseFullscreen")}
                  title={t("timelineCloseFullscreen")}
                  className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    // 关闭全屏必须先停止成片播放，避免声音继续在后台播放
                    stopPlayback();
                    setExpanded(false);
                  }}
                >
                  <X className="size-4" strokeWidth={1.8} />
                </button>
              </div>
            </header>
            <div className="flex min-h-0 flex-1">
              <aside className="flex w-48 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border/50 p-2">
                <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("timelineSources")}</p>
                {/* 时间线整体：按片段顺序播放全部素材，便于查看完整成片效果 */}
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-2 rounded-lg p-1.5 text-left transition-colors",
                    sequenceMode ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-accent",
                  )}
                  onClick={() => {
                    // 单素材预览可能正在播放，切回成片预览前先暂停
                    previewRef.current?.pause();
                    setSequenceMode(true);
                  }}
                >
                  <span className="relative flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                    <Film className="size-4 text-cyan-500" strokeWidth={1.6} />
                    <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white/90">
                      {totalDuration > 0 ? formatClock(totalDuration) : "--:--"}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">{t("timelineAllClips")}</span>
                </button>
                {uniqueSources.length === 0 ? (
                  <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("timelineEmpty")}</p>
                ) : uniqueSources.map((source) => {
                  const sourceDuration = node.segments
                    .filter((segment) => segment.sourceNodeID === source.sourceNodeID)
                    .reduce((sum, segment) => sum + durationOf(segment), 0);
                  return (
                    <button
                      key={source.sourceNodeID}
                      type="button"
                      className={cn(
                        "flex items-center gap-2 rounded-lg p-1.5 text-left transition-colors",
                        !sequenceMode && previewSource?.sourceNodeID === source.sourceNodeID ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-accent",
                      )}
                      onClick={() => {
                        // 切到单素材预览：先停掉整条时间线的播放，避免后台继续播放
                        if (playing) {
                          stopPlayback();
                        }
                        setSequenceMode(false);
                        setPreviewSourceID(source.sourceNodeID);
                      }}
                    >
                      <span className="relative flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                        {source.track === "audio" ? (
                          <AudioLines className="size-4 text-fuchsia-500" strokeWidth={1.6} />
                        ) : source.previewURL ? (
                          <video src={source.previewURL} muted playsInline preload="metadata" className="size-full object-cover" />
                        ) : (
                          <Film className="size-4 text-muted-foreground/60" strokeWidth={1.6} />
                        )}
                        <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white/90">
                          {sourceDuration > 0 ? formatClock(sourceDuration) : "--:--"}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px]">{source.name}</span>
                    </button>
                  );
                })}
              </aside>
              <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-black/90">
                {/* 成片播放器常驻挂载：切到单素材预览时只隐藏，不卸载，避免播放/暂停失效与黑屏 */}
                <div className={cn(
                  "absolute inset-0 flex items-center justify-center overflow-hidden",
                  sequenceMode ? "" : "pointer-events-none opacity-0",
                )}>
                    {videoSegments.length > 0 ? (
                      <>
                        {/* biome-ignore lint/a11y/useMediaCaption: 时间线成片预览，无字幕轨道 */}
                        <video
                          ref={setVideoElement}
                          className="size-full object-contain"
                          playsInline
                          preload="auto"
                          onTimeUpdate={handleVideoProgress}
                          onEnded={advanceVideo}
                          onClick={togglePlayback}
                        />
                        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pb-2.5 pt-8">
                          <button
                            type="button"
                            aria-label={playing ? t("timelinePause") : t("timelinePlay")}
                            title={playing ? t("timelinePause") : t("timelinePlay")}
                            className="flex size-7 items-center justify-center rounded-md text-white/90 transition-colors hover:bg-white/15"
                            onClick={(event) => {
                              event.stopPropagation();
                              togglePlayback();
                            }}
                          >
                            {playing ? <Pause className="size-4" strokeWidth={1.8} /> : <Play className="size-4" strokeWidth={1.8} />}
                          </button>
                          <span className="shrink-0 text-[11px] tabular-nums text-white/85">
                            {formatClock(playhead)} / {formatClock(totalDuration)}
                          </span>
                          <div
                            role="slider"
                            tabIndex={0}
                            aria-label={t("timelinePlayhead")}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={totalDuration > 0 ? Math.round((playhead / totalDuration) * 100) : 0}
                            className="relative h-1 min-w-0 flex-1 cursor-pointer rounded-full bg-white/25"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              const element = event.currentTarget;
                              const seek = (clientX: number) => {
                                const rect = element.getBoundingClientRect();
                                const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
                                const seconds = ratio * totalDuration;
                                if (playing) {
                                  startPlaybackAt(seconds);
                                  return;
                                }
                                setPlayhead(seconds);
                                previewFrameAt(seconds, true);
                              };
                              element.setPointerCapture?.(event.pointerId);
                              seek(event.clientX);
                              const onMove = (moveEvent: PointerEvent) => seek(moveEvent.clientX);
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
                            <span
                              className="absolute inset-y-0 left-0 rounded-full bg-primary"
                              style={{ width: `${totalDuration > 0 ? Math.min(100, (playhead / totalDuration) * 100) : 0}%` }}
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
                        {t("timelineEmpty")}
                      </div>
                    )}
                </div>
                {sequenceMode ? null : previewSource?.track === "audio" ? (
                  <div className="relative z-10 flex size-full flex-col items-center justify-center gap-4 p-6">
                    <AudioLines className="size-12 text-fuchsia-400" strokeWidth={1.4} />
                    {previewSource.previewURL ? (
                      // biome-ignore lint/a11y/useMediaCaption: 音频预览使用原生控件，无字幕轨道
                      <audio src={previewSource.previewURL} controls className="w-full max-w-md" />
                    ) : (
                      <p className="text-[11px] text-muted-foreground">{t("timelineNoSource")}</p>
                    )}
                  </div>
                ) : previewSource?.previewURL ? (
                  // biome-ignore lint/a11y/useMediaCaption: 视频预览使用原生控件，无字幕轨道
                  <video
                    ref={previewRef}
                    key={previewSource.sourceNodeID}
                    src={previewSource.previewURL}
                    controls
                    playsInline
                    preload="metadata"
                    className="relative z-10 size-full object-contain"
                  />
                ) : (
                  <div className="relative z-10 flex size-full items-center justify-center text-[11px] text-muted-foreground">
                    {t("timelineEmpty")}
                  </div>
                )}
              </div>
            </div>
            <footer className="shrink-0 border-t border-border/50 p-2">
              {renderToolbar(true)}
              <div ref={measureFullscreen} className="mt-1 flex max-h-[42vh] items-start overflow-auto">
                {renderTrackGutter(true)}
                {renderTimelineArea(true)}
              </div>
              {node.exportError ? (
                <p className="mt-1 px-1 text-[10px] leading-relaxed text-destructive">{node.exportError}</p>
              ) : null}
            </footer>
          </div>
        </DialogContent>
      </Dialog>
    </GraphNodeShell>
  );
}
