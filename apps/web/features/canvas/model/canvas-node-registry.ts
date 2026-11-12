import {
  AudioLines,
  Clapperboard,
  Film,
  Image as ImageIcon,
  TextCursorInput,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { GraphPortDefinition } from "@/features/canvas/model/canvas-graph";
import type { CanvasMediaKind, CanvasMediaType, CanvasNodeMediaHint, GraphInputPort, GraphNodeKind } from "@/features/canvas/model/canvas-types";

// ---------------------------------------------------------------------------
// 节点类型注册表：每类节点的静态元数据（尺寸 / 端口 / 主题色 / 连线规则 / 工具栏）
// 的唯一事实来源。canvas-types / canvas-graph / 节点外壳 / 工具栏均从此派生，
// 新增节点类型只需在此登记一条记录。
// 注意：本模块仅以 import type 引用 canvas-types / canvas-graph，避免运行时循环依赖。
// ---------------------------------------------------------------------------

// 工具栏按钮：labelKey / descriptionKey 为 canvas 命名空间的 i18n 键；
// mediaType 用于区分同一节点的不同工作流入口（生成节点的图像 / 视频，媒体节点的视频 / 音频）。
export type CanvasToolbarAction = {
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  mediaType?: CanvasNodeMediaHint;
};

export type CanvasNodeRegistryEntry = {
  kind: GraphNodeKind;
  size: { width: number; height: number };
  // 按媒体类型覆盖尺寸（生成节点的视频工作流更高）
  sizeByMediaType?: Partial<Record<CanvasMediaType, { width: number; height: number }>>;
  // 按素材类型覆盖尺寸（音频素材节点用横向长条）
  sizeByMediaKind?: Partial<Record<CanvasMediaKind, { width: number; height: number }>>;
  ports: GraphPortDefinition[];
  // 按媒体类型覆盖端口（视频生成节点额外提供参考视频 / 参考音频入端口）
  portsByMediaType?: Partial<Record<CanvasMediaType, GraphPortDefinition[]>>;
  accent: { dot: string; soft: string; ring: string };
  connectionRules: { toKind: GraphNodeKind; toPort: GraphInputPort }[];
  // 空数组表示不在工具栏出按钮（例如输出节点由生成流程自动产生）
  toolbar: CanvasToolbarAction[];
};

export const CANVAS_NODE_REGISTRY: Record<GraphNodeKind, CanvasNodeRegistryEntry> = {
  prompt: {
    kind: "prompt",
    size: { width: 288, height: 224 },
    ports: [{ id: "out", direction: "out", offsetX: 1, offsetY: 60 }],
    accent: { dot: "bg-violet-500", soft: "text-violet-500", ring: "ring-violet-500/40" },
    connectionRules: [{ toKind: "generate", toPort: "prompt" }],
    // 文本节点：连接生成节点的文本端口后，内容自动填充到节点提示词
    toolbar: [{ labelKey: "addPromptNode", descriptionKey: "toolbarNodePrompt", icon: TextCursorInput }],
  },
  image: {
    kind: "image",
    size: { width: 288, height: 264 },
    ports: [{ id: "out", direction: "out", offsetX: 1, offsetY: 60 }],
    accent: { dot: "bg-sky-500", soft: "text-sky-500", ring: "ring-sky-500/40" },
    connectionRules: [{ toKind: "generate", toPort: "image" }],
    toolbar: [{ labelKey: "addImageNode", descriptionKey: "toolbarNodeImage", icon: ImageIcon }],
  },
  // 参考媒体节点：上传参考视频或参考音频，供视频生成节点引用
  media: {
    kind: "media",
    size: { width: 288, height: 264 },
    // 音频素材是横向长条：显示波形与播放时间轴
    sizeByMediaKind: { audio: { width: 380, height: 156 } },
    ports: [{ id: "out", direction: "out", offsetX: 1, offsetY: 60 }],
    accent: { dot: "bg-fuchsia-500", soft: "text-fuchsia-500", ring: "ring-fuchsia-500/40" },
    connectionRules: [
      { toKind: "generate", toPort: "video" },
      { toKind: "generate", toPort: "audio" },
      { toKind: "timeline", toPort: "video" },
      { toKind: "timeline", toPort: "audio" },
    ],
    toolbar: [
      { labelKey: "addMediaVideoNode", descriptionKey: "toolbarNodeMediaVideo", icon: Video, mediaType: "video" },
      { labelKey: "addMediaAudioNode", descriptionKey: "toolbarNodeMediaAudio", icon: AudioLines, mediaType: "audio" },
    ],
  },
  generate: {
    kind: "generate",
    // 生成与输出合并为单一媒体节点：固定尺寸承载结果预览、提示词摘要与参数行
    size: { width: 344, height: 400 },
    sizeByMediaType: { video: { width: 344, height: 452 } },
    // 入端口沿卡片左侧固定分布；参考内容仍通过连线表达
    ports: [
      { id: "prompt", direction: "in", offsetX: 0, offsetY: 120 },
      { id: "image", direction: "in", offsetX: 0, offsetY: 168 },
      { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
    ],
    portsByMediaType: {
      video: [
        { id: "prompt", direction: "in", offsetX: 0, offsetY: 120 },
        { id: "image", direction: "in", offsetX: 0, offsetY: 168 },
        { id: "video", direction: "in", offsetX: 0, offsetY: 216 },
        { id: "audio", direction: "in", offsetX: 0, offsetY: 264 },
        { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
      ],
    },
    accent: { dot: "bg-amber-500", soft: "text-amber-500", ring: "ring-amber-500/40" },
    // 生成结果可直接作为下一节点的参考素材，连线只表达参考内容
    connectionRules: [
      { toKind: "generate", toPort: "image" },
      { toKind: "generate", toPort: "video" },
      { toKind: "timeline", toPort: "video" },
    ],
    // 图像生成与视频生成两条入口：图像入口与参考图共用图标，视频入口带 mediaType: "video"
    toolbar: [
      { labelKey: "addGenerateImageNode", descriptionKey: "toolbarNodeGenerateImage", icon: ImageIcon },
      { labelKey: "addGenerateVideoNode", descriptionKey: "toolbarNodeGenerateVideo", icon: Clapperboard, mediaType: "video" },
    ],
  },
  output: {
    kind: "output",
    size: { width: 288, height: 352 },
    ports: [
      // 入端口与生成节点的出端口取同一高度，使两者之间的连线保持水平
      { id: "result", direction: "in", offsetX: 0, offsetY: 60 },
      { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
    ],
    accent: { dot: "bg-emerald-500", soft: "text-emerald-500", ring: "ring-emerald-500/40" },
    // 产物可回灌为下一轮生成的输入：图像产物作参考图，视频产物作参考视频
    connectionRules: [
      { toKind: "generate", toPort: "image" },
      { toKind: "generate", toPort: "video" },
      { toKind: "timeline", toPort: "video" },
    ],
    // 输出节点由生成流程自动产生，不在工具栏出按钮
    toolbar: [],
  },
  // 时间线节点：横向剪辑面板，接入多个视频素材/结果后按片段顺序拼接并导出
  timeline: {
    kind: "timeline",
    // 高度按两条轨道 + 工具栏设计，新增轨道在节点内滚动查看
    size: { width: 720, height: 208 },
    ports: [
      { id: "video", direction: "in", offsetX: 0, offsetY: 96 },
      { id: "audio", direction: "in", offsetX: 0, offsetY: 144 },
      { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
    ],
    accent: { dot: "bg-cyan-500", soft: "text-cyan-500", ring: "ring-cyan-500/40" },
    // 时间线导出后生成的视频可通过出端口作为其他节点的参考视频
    connectionRules: [{ toKind: "generate", toPort: "video" }],
    toolbar: [{ labelKey: "addTimelineNode", descriptionKey: "toolbarNodeTimeline", icon: Film }],
  },
};

// 工具栏按钮列表：按注册表登记顺序展平（生成节点产出图像 / 视频两条，媒体节点产出视频 / 音频两条）
export const CANVAS_TOOLBAR_ACTIONS: Array<CanvasToolbarAction & { kind: GraphNodeKind }> = Object.values(
  CANVAS_NODE_REGISTRY,
).flatMap((entry) => entry.toolbar.map((action) => ({ kind: entry.kind, ...action })));
