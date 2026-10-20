import type { ConversationOptions } from "@/shared/api/conversation-types";
import { CANVAS_NODE_REGISTRY } from "@/features/canvas/model/canvas-node-registry";

export type CanvasPointerMode = "pan" | "select";
export type CanvasNodeReference = { fileID: string; fileName: string; mimeType: string; sizeBytes: number };
export type CanvasOperation = "generate" | "edit" | "inpaint" | "outpaint" | "crop";
// 创作画布媒体类型：生成/输出节点区分图像与视频工作流
export type CanvasMediaType = "image" | "video";
// 画布使用模式：graph 节点图编排（默认）/ chat 对话输入条（移动端默认，PC 可自选）
export type CanvasViewMode = "graph" | "chat";
export type CanvasElementMeta = { locked?: boolean; groupID?: string | null; frameID?: string | null; zIndex?: number };

// ---------------------------------------------------------------------------
// 节点图模型：提示词 / 参考图 / 参考媒体 / 生成 / 输出五类连线节点
// ---------------------------------------------------------------------------
export type GraphNodeKind = "prompt" | "image" | "media" | "generate" | "output";
// 生成节点的运行状态：idle 未运行；pending/streaming 执行中
export type GraphRunStatus = "idle" | "pending" | "streaming";
// 参考媒体节点的素材类型：视频或音频
export type CanvasMediaKind = "video" | "audio";
// 新建节点时的媒体提示：图像 / 视频生成节点入口，媒体节点的视频 / 音频素材入口
export type CanvasNodeMediaHint = CanvasMediaType | CanvasMediaKind;

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

// 参考媒体节点：持有一个已上传的参考视频或音频，供视频生成节点引用
export type MediaGraphNode = GraphNodeBase & {
  kind: "media";
  mediaKind: CanvasMediaKind;
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
  // 媒体类型决定路由（图像 media 路由 / 视频生成路由）、参数面板与输出形态
  mediaType: CanvasMediaType;
  model: string | null;
  // 模型作用域与用户模型 ID：同一模型名可能存在于多个接口（用户模型按上游重复），
  // 以此精确定位目录中的唯一模型条目
  modelScope?: "platform" | "user";
  userModelID?: number;
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
  // 运行中的任务会话与运行 ID：刷新后据此走三层恢复兜底；完成后清除
  conversationID?: string;
  runID?: string;
  progress?: number;
  // 上游清单总行数（瞬态派生，不持久化）：节点高度按它增长
  connectionRows?: number;
  // 每个入端口的清单行数（瞬态派生，不持久化）：端口纵向锚点与清单行对齐
  portRowCounts?: number[];
};

// 输出节点的待重试保存引用：上游生成已成功但产物保存瞬时失败，
// 输出节点持有运行与产物序号，可自行重试保存而不占用生成节点状态。
export type OutputPendingRetry = {
  mediaType: CanvasMediaType;
  runID: string;
  index: number;
};

// 输出节点：展示生成结果图像/视频，可通过出端口链式接入下一个生成节点。
// 任务创建时运行状态即转交到本节点：等待/流式响应/进度/取消/重查都在输出节点上呈现，
// 生成节点只保留模型与参数配置。
export type OutputGraphNode = GraphNodeBase & {
  kind: "output";
  mediaType?: CanvasMediaType;
  status: "empty" | "running" | "done" | "error";
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
  durationSeconds?: number;
  // 产物保存待重试：生成已成功，保存失败后由本节点重试（图像重下载 / 视频重查）
  pendingRetry?: OutputPendingRetry;
  // 保存重试进行中（瞬态标记，不持久化）：UI 显示加载态并隐藏重试按钮
  retrySaving?: boolean;
  // 任务绑定：运行中的任务持有会话与运行 ID，刷新后据此走恢复兜底；完成后清除
  conversationID?: string;
  runID?: string;
  // 运行状态展示（瞬态，不持久化）：状态文案 / 视频进度百分比 / 流式图像预览
  statusLabel?: string;
  progress?: number;
  previewURL?: string;
};

// HTML 预览节点已移除；保留占位注释以便阅读历史差异。
export type GraphNode = PromptGraphNode | ImageGraphNode | MediaGraphNode | GenerateGraphNode | OutputGraphNode;

// 图节点部分更新补丁：按节点类型取联合，避免 kind 字面量交叉被 TS 归约为 never
export type GraphNodeUpdate =
  | Partial<PromptGraphNode>
  | Partial<ImageGraphNode>
  | Partial<MediaGraphNode>
  | Partial<GenerateGraphNode>
  | Partial<OutputGraphNode>;

// 连线：fromNodeID 的出端口 -> toNodeID 的入端口
export type GraphInputPort = "prompt" | "image" | "video" | "audio" | "result";
export type GraphEdge = {
  id: string;
  fromNodeID: string;
  toNodeID: string;
  toPort: GraphInputPort;
  createdAt: number;
};

// 各类节点的固定尺寸（端口几何依赖固定尺寸进行定位），从节点注册表派生
export const GRAPH_NODE_SIZES: Record<GraphNodeKind, { width: number; height: number }> =
  Object.fromEntries(
    Object.values(CANVAS_NODE_REGISTRY).map((entry) => [entry.kind, entry.size] as const),
  ) as Record<GraphNodeKind, { width: number; height: number }>;

// 节点尺寸入参：媒体类型决定生成 / 输出节点的工作流尺寸，连接行数决定生成节点的动态高度
export type GraphNodeSizeInput = { kind: GraphNodeKind; mediaType?: CanvasMediaType; connectionRows?: number };

// 生成节点每个上游连接行占用的额外高度
export const GENERATE_CONNECTION_ROW_HEIGHT = 18;
// 生成节点固定部分高度（标题栏 + 模型/参数行 + 运行按钮 + 内边距）：
// 其余高度全部留给上游清单区，清单有几行就占几行，避免出现大面积空白
export const GENERATE_NODE_FIXED_HEIGHT = 170;
// 上游清单区最小高度：端口全部未连接时也要留出足够的点击与阅读空间
export const GENERATE_LIST_MIN_HEIGHT = 150;

// 生成节点高度 = 固定部分 + 清单区（随上游行数增长，不足最小值时保持最小值）
export function generateNodeHeight(connectionRows: number): number {
  const rows = Math.max(0, connectionRows);
  return GENERATE_NODE_FIXED_HEIGHT + Math.max(GENERATE_LIST_MIN_HEIGHT, rows * GENERATE_CONNECTION_ROW_HEIGHT);
}

export function graphNodeSize(node: GraphNodeSizeInput): { width: number; height: number } {
  const entry = CANVAS_NODE_REGISTRY[node.kind];
  const base = (node.mediaType ? entry.sizeByMediaType?.[node.mediaType] : undefined) ?? entry.size;
  if (node.kind === "generate") {
    return { width: base.width, height: generateNodeHeight(node.connectionRows ?? 0) };
  }
  return base;
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
  kind: "generate"; mediaType?: CanvasMediaType; model: string | null; options?: ConversationOptions; resultCount: number;
  operation: CanvasOperation; maskReference?: CanvasNodeReference | null; errorMessage?: string; errorDetail?: string;
  // 模型作用域与用户模型 ID（区分不同接口下的同名模型）
  modelScope?: "platform" | "user"; userModelID?: number;
  // 运行中任务恢复所需的会话与运行 ID（仅运行期间存在）
  conversationID?: string; runID?: string;
};
// 参考媒体节点：持久化素材类型与引用
export type PersistedMediaGraphNode = PersistedGraphNodeBase & {
  kind: "media"; mediaKind?: CanvasMediaKind; reference: CanvasNodeReference | null; uploading?: boolean;
};
export type PersistedOutputGraphNode = PersistedGraphNodeBase & {
  kind: "output"; mediaType?: CanvasMediaType; status: "empty" | "running" | "done" | "error";
  fileID?: string; fileName?: string; mimeType?: string; sizeBytes?: number;
  prompt?: string; model?: string; sourceGenerateID?: string | null;
  errorMessage?: string; errorDetail?: string; completedAt?: number; durationMs?: number; durationSeconds?: number;
  pendingRetry?: OutputPendingRetry;
  // 运行中任务的恢复引用（仅运行期间存在）
  conversationID?: string; runID?: string;
};
export type PersistedGraphNode =
  | PersistedPromptGraphNode
  | PersistedImageGraphNode
  | PersistedMediaGraphNode
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
  projectName?: string;
  activeCanvasID?: string;
  canvases?: PersistedCanvasPage[];
  versions?: CanvasVersion[];
  conversationID: string | null;
  selectedModelName: string | null;
  selectedVideoModelName?: string | null;
  // 模型身份键（platform:<名称> / user:<用户模型ID>）：区分不同接口下的同名模型
  selectedModelKey?: string | null;
  selectedVideoModelKey?: string | null;
  pointerMode: CanvasPointerMode;
  // 使用模式（对话/节点图）；缺省时按设备宽度回退
  viewMode?: CanvasViewMode;
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
export const CANVAS_UI_ATTRIBUTE = "data-canvas-ui";
export const PROMPT_TEMPLATES_STORAGE_KEY = "deeix_canvas_prompt_templates_v1";
export const PROMPT_MAX_LENGTH = 20000;
export function snapToGrid(value: number): number { return Math.round(value / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE; }
