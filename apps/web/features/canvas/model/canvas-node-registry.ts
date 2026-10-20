import {
  AudioLines,
  Clapperboard,
  Image as ImageIcon,
  TextCursorInput,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { GraphPortDefinition } from "@/features/canvas/model/canvas-graph";
import type { CanvasMediaType, CanvasNodeMediaHint, GraphInputPort, GraphNodeKind } from "@/features/canvas/model/canvas-types";

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
    ports: [{ id: "out", direction: "out", offsetX: 1, offsetY: 60 }],
    accent: { dot: "bg-fuchsia-500", soft: "text-fuchsia-500", ring: "ring-fuchsia-500/40" },
    connectionRules: [
      { toKind: "generate", toPort: "video" },
      { toKind: "generate", toPort: "audio" },
    ],
    toolbar: [
      { labelKey: "addMediaVideoNode", descriptionKey: "toolbarNodeMediaVideo", icon: Video, mediaType: "video" },
      { labelKey: "addMediaAudioNode", descriptionKey: "toolbarNodeMediaAudio", icon: AudioLines, mediaType: "audio" },
    ],
  },
  generate: {
    kind: "generate",
    // 高度由 generateNodeHeight 按上游清单行数派生，此处 height 仅作默认占位
    size: { width: 336, height: 320 },
    // 入端口纵向落在生成区（红框）范围内：连接清单与运行状态都在该区域内展示，
    // 端口位置与生成区对齐后，"哪个点连什么"可以顺着连线一眼对上清单行
    ports: [
      { id: "prompt", direction: "in", offsetX: 0, offsetY: 208 },
      { id: "image", direction: "in", offsetX: 0, offsetY: 300 },
      // 出端口与其余节点保持一致，落在标题栏下方的上部锚点；入端口才按清单行对齐
      { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
    ],
    portsByMediaType: {
      video: [
        { id: "prompt", direction: "in", offsetX: 0, offsetY: 188 },
        { id: "image", direction: "in", offsetX: 0, offsetY: 259 },
        { id: "video", direction: "in", offsetX: 0, offsetY: 330 },
        { id: "audio", direction: "in", offsetX: 0, offsetY: 401 },
        { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
      ],
    },
    accent: { dot: "bg-amber-500", soft: "text-amber-500", ring: "ring-amber-500/40" },
    connectionRules: [{ toKind: "output", toPort: "result" }],
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
    ],
    // 输出节点由生成流程自动产生，不在工具栏出按钮
    toolbar: [],
  },
};

// 工具栏按钮列表：按注册表登记顺序展平（生成节点产出图像 / 视频两条，媒体节点产出视频 / 音频两条）
export const CANVAS_TOOLBAR_ACTIONS: Array<CanvasToolbarAction & { kind: GraphNodeKind }> = Object.values(
  CANVAS_NODE_REGISTRY,
).flatMap((entry) => entry.toolbar.map((action) => ({ kind: entry.kind, ...action })));
