import {
  Clapperboard,
  CodeXml,
  Image as ImageIcon,
  Play,
  TextCursorInput,
  type LucideIcon,
} from "lucide-react";
import type { GraphPortDefinition } from "@/features/canvas/model/canvas-graph";
import type { GraphInputPort, GraphNodeKind } from "@/features/canvas/model/canvas-types";

// ---------------------------------------------------------------------------
// 节点类型注册表：每类节点的静态元数据（尺寸 / 端口 / 主题色 / 连线规则 / 工具栏）
// 的唯一事实来源。canvas-types / canvas-graph / 节点外壳 / 工具栏均从此派生，
// 新增节点类型只需在此登记一条记录。
// 注意：本模块仅以 import type 引用 canvas-types / canvas-graph，避免运行时循环依赖。
// ---------------------------------------------------------------------------

// 工具栏按钮：labelKey / descriptionKey 为 canvas 命名空间的 i18n 键；
// mediaType 用于区分同一节点的不同媒体工作流入口（如生成节点的图像 / 视频两条）。
export type CanvasToolbarAction = {
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  mediaType?: "image" | "video";
};

export type CanvasNodeRegistryEntry = {
  kind: GraphNodeKind;
  size: { width: number; height: number };
  ports: GraphPortDefinition[];
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
  generate: {
    kind: "generate",
    size: { width: 336, height: 512 },
    // 生成节点：提示词与参考图两个入端口位于左侧，结果出端口位于右侧
    ports: [
      { id: "prompt", direction: "in", offsetX: 0, offsetY: 96 },
      { id: "image", direction: "in", offsetX: 0, offsetY: 188 },
      { id: "out", direction: "out", offsetX: 1, offsetY: 300 },
    ],
    accent: { dot: "bg-amber-500", soft: "text-amber-500", ring: "ring-amber-500/40" },
    connectionRules: [{ toKind: "output", toPort: "result" }],
    // 图像生成与视频生成两条入口：视频入口带 mediaType: "video"
    toolbar: [
      { labelKey: "addGenerateNode", descriptionKey: "toolbarNodeGenerate", icon: Play },
      { labelKey: "addGenerateVideoNode", descriptionKey: "toolbarNodeGenerateVideo", icon: Clapperboard, mediaType: "video" },
    ],
  },
  output: {
    kind: "output",
    size: { width: 288, height: 352 },
    ports: [
      { id: "result", direction: "in", offsetX: 0, offsetY: 176 },
      { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
    ],
    accent: { dot: "bg-emerald-500", soft: "text-emerald-500", ring: "ring-emerald-500/40" },
    connectionRules: [{ toKind: "generate", toPort: "image" }],
    // 输出节点由生成流程自动产生，不在工具栏出按钮
    toolbar: [],
  },
  html: {
    kind: "html",
    size: { width: 360, height: 320 },
    // 独立节点，不参与连线
    ports: [],
    accent: { dot: "bg-primary", soft: "text-primary", ring: "ring-primary/40" },
    connectionRules: [],
    toolbar: [{ labelKey: "addHtmlNode", descriptionKey: "toolbarNodeHtml", icon: CodeXml }],
  },
};

// 工具栏按钮列表：按注册表登记顺序展平（生成节点产出图像 / 视频两条）
export const CANVAS_TOOLBAR_ACTIONS: Array<CanvasToolbarAction & { kind: GraphNodeKind }> = Object.values(
  CANVAS_NODE_REGISTRY,
).flatMap((entry) => entry.toolbar.map((action) => ({ kind: entry.kind, ...action })));
