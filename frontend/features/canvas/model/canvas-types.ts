import type { ConversationOptions } from "@/shared/api/conversation.types";

export type CanvasPointerMode = "pan" | "select";
export type CanvasNodeReference = { fileID: string; fileName: string; mimeType: string; sizeBytes: number };
export type CanvasOperation = "generate" | "edit" | "inpaint" | "outpaint" | "crop";
export type CanvasElementMeta = { locked?: boolean; groupID?: string | null; frameID?: string | null; zIndex?: number };

// ---------------------------------------------------------------------------
// 节点图模型：提示词 / 参考图 / 生成 / 输出四类节点，通过端口连线组成工作流
// ---------------------------------------------------------------------------
export type GraphNodeKind = "prompt" | "image" | "generate" | "output";
// 生成节点的运行状态：idle 未运行；pending/streaming 执行中
export type GraphRunStatus = "idle" | "pending" | "streaming";

export type GraphNodeBase = CanvasElementMeta & {
  id: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
  createdAt: number;
};

// 提示词节点：承载提示词文本，可引用模板库
export type PromptGraphNode = GraphNodeBase & {
  kind: "prompt";
  text: string;
};

// 参考图节点：持有一张已上传的参考图片
export type ImageGraphNode = GraphNodeBase & {
  kind: "image";
  reference: CanvasNodeReference | null;
  previewURL?: string;
  uploading?: boolean;
  // 预览加载状态：仅运行时使用（fileID -> objectURL 拉取过程），不持久化
  previewLoading?: boolean;
  previewFailed?: boolean;
};

// 生成节点：模型选择、模型参数、生成数量与运行状态都配置在节点内
export type GenerateGraphNode = GraphNodeBase & {
  kind: "generate";
  model: string | null;
  options: ConversationOptions;
  resultCount: number;
  operation: CanvasOperation;
  // 局部重绘等场景由图像编辑器注入，不经端口连线
  maskReference?: CanvasNodeReference | null;
  runStatus: GraphRunStatus;
  statusLabel?: string;
  previewURL?: string;
  errorMessage?: string;
  errorDetail?: string;
};

// 输出节点：展示生成结果图像，可通过出端口链式接入下一个生成节点
export type OutputGraphNode = GraphNodeBase & {
  kind: "output";
  status: "empty" | "done" | "error";
  fileID?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  objectURL?: string;
  imageLoadFailed?: boolean;
  prompt?: string;
  model?: string;
  sourceGenerateID?: string | null;
  errorMessage?: string;
  errorDetail?: string;
  completedAt?: number;
  durationMs?: number;
};

export type GraphNode = PromptGraphNode | ImageGraphNode | GenerateGraphNode | OutputGraphNode;

// 图节点部分更新补丁：按节点类型取联合，避免 kind 字面量交叉被 TS 归约为 never
export type GraphNodeUpdate =
  | Partial<PromptGraphNode>
  | Partial<ImageGraphNode>
  | Partial<GenerateGraphNode>
  | Partial<OutputGraphNode>;

// 连线：fromNodeID 的出端口 -> toNodeID 的入端口
export type GraphInputPort = "prompt" | "image" | "result";
export type GraphEdge = {
  id: string;
  fromNodeID: string;
  toNodeID: string;
  toPort: GraphInputPort;
  createdAt: number;
};

// 各类节点的固定尺寸（端口几何依赖固定尺寸进行定位）
export const GRAPH_NODE_SIZES: Record<GraphNodeKind, { width: number; height: number }> = {
  prompt: { width: 288, height: 224 },
  image: { width: 288, height: 264 },
  generate: { width: 336, height: 512 },
  output: { width: 288, height: 352 },
};

export function graphNodeSize(node: Pick<GraphNode, "kind">): { width: number; height: number } {
  return GRAPH_NODE_SIZES[node.kind];
}

export type CanvasDecoration = CanvasElementMeta & {
  id: string;
  kind: "frame" | "section" | "note";
  x: number; y: number; width: number; height: number;
  title: string; text: string; color: string; createdAt: number; collapsed?: boolean;
};
export type CanvasViewport = { x: number; y: number; scale: number };
export type CanvasBookmark = { id: string; name: string; viewport: CanvasViewport; createdAt: number };

// ---------------------------------------------------------------------------
// 持久化模型（v4）：graphNodes + edges；兼容读取 v3 及更早的旧图像卡片数据
// ---------------------------------------------------------------------------
export type PersistedGraphNodeBase = {
  id: string; kind: GraphNodeKind; x: number; y: number; createdAt: number;
  locked?: boolean; groupID?: string | null; frameID?: string | null; zIndex?: number;
};
export type PersistedPromptGraphNode = PersistedGraphNodeBase & { kind: "prompt"; text: string };
export type PersistedImageGraphNode = PersistedGraphNodeBase & {
  kind: "image"; reference: CanvasNodeReference | null; uploading?: boolean;
};
export type PersistedGenerateGraphNode = PersistedGraphNodeBase & {
  kind: "generate"; model: string | null; options?: ConversationOptions; resultCount: number;
  operation: CanvasOperation; maskReference?: CanvasNodeReference | null; errorMessage?: string; errorDetail?: string;
};
export type PersistedOutputGraphNode = PersistedGraphNodeBase & {
  kind: "output"; status: "empty" | "done" | "error";
  fileID?: string; fileName?: string; mimeType?: string; sizeBytes?: number;
  prompt?: string; model?: string; sourceGenerateID?: string | null;
  errorMessage?: string; errorDetail?: string; completedAt?: number; durationMs?: number;
};
export type PersistedGraphNode =
  | PersistedPromptGraphNode
  | PersistedImageGraphNode
  | PersistedGenerateGraphNode
  | PersistedOutputGraphNode;
export type PersistedGraphEdge = { id: string; fromNodeID: string; toNodeID: string; toPort: GraphInputPort; createdAt: number };

// 旧版图像卡片持久化结构（仅用于 v3 -> v4 迁移）
export type PersistedCanvasNode = {
  id: string; x: number; y: number; prompt: string; model: string; createdAt: number;
  status: "pending" | "streaming" | "done" | "error"; parentID?: string | null;
  reference?: CanvasNodeReference | null; references?: CanvasNodeReference[]; maskReference?: CanvasNodeReference | null;
  operation?: CanvasOperation; batchID?: string; version?: number; completedAt?: number; durationMs?: number;
  options?: ConversationOptions; fileID?: string; fileName?: string;
  mimeType?: string; sizeBytes?: number; errorMessage?: string; errorDetail?: string;
  locked?: boolean; groupID?: string | null; frameID?: string | null; zIndex?: number;
};
export type PersistedCanvasPage = {
  id: string; name: string; viewport: CanvasViewport;
  nodes: PersistedCanvasNode[];
  graphNodes?: PersistedGraphNode[];
  edges?: PersistedGraphEdge[];
  decorations: CanvasDecoration[]; bookmarks: CanvasBookmark[]; createdAt: number; updatedAt: number;
};
export type CanvasVersion = { id: string; name: string; createdAt: number; activeCanvasID: string; canvases: PersistedCanvasPage[] };
export type PersistedCanvasState = {
  version?: 4;
  // 快照写入时间：用于云端/本地双端比较，避免旧云端快照覆盖较新的本地状态
  savedAt?: number;
  projectName?: string;
  activeCanvasID?: string;
  canvases?: PersistedCanvasPage[];
  versions?: CanvasVersion[];
  conversationID: string | null;
  selectedModelName: string | null;
  pointerMode: CanvasPointerMode;
  viewport: CanvasViewport;
  // 顶层 nodes 仅作旧版兼容读取；v4 数据存于 canvases[].graphNodes
  nodes?: PersistedCanvasNode[];
  graphNodes?: PersistedGraphNode[];
  edges?: PersistedGraphEdge[];
  decorations?: CanvasDecoration[];
  bookmarks?: CanvasBookmark[];
  imageOptions: Record<string, ConversationOptions>;
};

export const CANVAS_GRID_SIZE = 8;
export const CANVAS_MIN_SCALE = 0.2;
export const CANVAS_MAX_SCALE = 4;
export const CANVAS_STORAGE_KEY = "deeix_canvas_state_v4";
export const CANVAS_LEGACY_STORAGE_KEY = "deeix_canvas_state_v3";
export const CANVAS_CLOUD_SETTING_KEY = "canvas.state_v1";
export const CANVAS_UI_ATTRIBUTE = "data-canvas-ui";
export const PROMPT_TEMPLATES_STORAGE_KEY = "deeix_canvas_prompt_templates_v1";
export const PROMPT_MAX_LENGTH = 20000;
export function snapToGrid(value: number): number { return Math.round(value / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE; }
