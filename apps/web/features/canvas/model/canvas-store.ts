import { toast } from "sonner";
import {
  canvasChatImageSourceToFile,
  resolveCanvasChatImageSource,
} from "@/features/canvas/model/canvas-chat-image";
import {
  canConnectGraphNodes,
  type GraphConnectionAttempt,
  type GraphPortID,
  gatherGraphGenerateInputs,
  graphGenerateHasInputs,
  graphNodePorts,
} from "@/features/canvas/model/canvas-graph";
import {
  canvasModelKey,
  chatImagePromptSuffix,
  isChatRouteImageModel,
  mergeCanvasOptions,
  modelCanvasMediaType,
  parseCanvasModelKey,
  resolveCanvasMediaRoute,
  type CanvasModelOption,
} from "@/features/canvas/model/canvas-image-options";
import {
  canvasElementIDsCarriedByFrame,
  type FrameRefitElement,
  frameUnionBounds,
  refitFrameDecorations,
  stableFrameIDForElement,
} from "@/features/canvas/model/canvas-interactions";
import {
  clearCanvasState,
  graphEdge,
  graphNode,
  loadCanvasState,
  restoreEdges,
  restoreGraphNodes,
  saveCanvasState,
  stringifyCanvasState,
  toPersistedEdges,
  toPersistedGraphNodes,
} from "@/features/canvas/model/canvas-persist";
import {
  canvasAssetKind,
  promptAssetFileIDs,
  promptForModelWithAssets,
} from "@/features/canvas/model/canvas-prompt";
import type { GraphNodeUpdate } from "@/features/canvas/model/canvas-types";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasBookmark,
  type CanvasDecoration,
  type CanvasMediaKind,
  type CanvasMediaType,
  type CanvasNodeMediaHint,
  type CanvasNodeReference,
  type CanvasOperation,
  type CanvasPointerMode,
  type CanvasVersion,
  type CanvasViewMode,
  type CanvasViewport,
  type GenerateGraphNode,
  GRAPH_NODE_SIZES,
  type GraphEdge,
  type GraphInputPort,
  type GraphNode,
  type GraphNodeKind,
  graphNodeSize,
  type ImageGraphNode,
  type MediaGraphNode,
  type OutputGraphNode,
  type OutputPendingRetry,
  type PersistedCanvasPage,
  type PersistedCanvasState,
  type PromptGraphNode,
  type TimelineGraphNode,
} from "@/features/canvas/model/canvas-types";
import { parseAttachments } from "@/features/chat";
import type { ConversationStreamOptions, MediaArtifactPendingEvent } from "@/shared/api/conversation";
import {
  createConversation,
  deleteConversation,
  getConversationRunStatuses,
  listMessages,
  requeryMediaVideoRun,
  resumeMessageGenerationStream,
  retryMediaImageArtifact,
  streamImageEdit,
  streamImageGeneration,
  streamMessage,
  streamVideoGeneration,
} from "@/shared/api/conversation";
import type {
  ConversationOptions,
  MediaImageRequest,
  MediaVideoRequest,
  MessageDTO,
  SendMessageRequest,
} from "@/shared/api/conversation-types";
import { fetchFileContent, uploadFile } from "@/shared/api/file";
import { ApiError, ApiNetworkError } from "@/shared/api/http-client";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { resolveLocalizedErrorMessageWithoutReference } from "@/i18n/resolve-error-message";
import { isFiniteNumber, isRecord, parseJSON, readString } from "@/shared/lib/type-guards";

// 生成流程所需的本地化文案，由组件层注入，避免 store 依赖 React 上下文
export type CanvasStoreLabels = {
  conversationTitle: string;
  needLogin: string;
  conversationCreateFailed: string;
  nodePreparing: string;
  nodeSavingLocal: string;
  nodeGenerationInterrupted: string;
  statusQueued: string;
  statusRunning: string;
  statusSavingArtifact: string;
  statusVideoQueued: string;
  statusVideoRunning: string;
  statusVideoSavingArtifact: string;
  nodeProgress: string;
  generateFailed: string;
  canceled: string;
  moderationBlocked: string;
  noImageOutput: string;
  noVideoOutput: string;
  noVideoModels: string;
  editReferenceRequired: string;
  editUnsupported: string;
  imageUnsupported: string;
  videoUnsupported: string;
  noImageModels: string;
  missingPromptInput: string;
  videoPromptRequired: string;
  nodeRequery: string;
  requeryStarted: string;
  requeryPending: string;
  requeryTimeout: string;
  requeryUnavailable: string;
  requeryRecovered: string;
  artifactSavePending: string;
  artifactRetrySaving: string;
  artifactRetryFailed: string;
  artifactRecovered: string;
  artifactExpired: string;
};

export type CanvasState = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  decorations: CanvasDecoration[];
  bookmarks: CanvasBookmark[];
  canvases: PersistedCanvasPage[];
  activeCanvasID: string;
  projectName: string;
  versions: CanvasVersion[];
  viewport: CanvasViewport;
  conversationID: string | null;
  pointerMode: CanvasPointerMode;
  // 使用模式：graph 节点图 / chat 对话输入条；PC 与移动端均可切换
  viewMode: CanvasViewMode;
  selectedNodeIDs: string[];
  selectedDecorationIDs: string[];
  selectedEdgeIDs: string[];
  restoredModelName: string | null;
  restoredVideoModelName: string | null;
  // 模型身份键：区分不同接口下的同名模型
  restoredModelKey: string | null;
  restoredVideoModelKey: string | null;
  generatingCount: number;
  restored: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

const initialState: CanvasState = {
  nodes: [],
  edges: [],
  decorations: [],
  bookmarks: [],
  canvases: [],
  activeCanvasID: "canvas-main",
  projectName: "Untitled project",
  versions: [],
  viewport: { x: 0, y: 0, scale: 1 },
  conversationID: null,
  pointerMode: "pan",
  viewMode: "graph",
  selectedNodeIDs: [],
  selectedDecorationIDs: [],
  selectedEdgeIDs: [],
  restoredModelName: null,
  restoredVideoModelName: null,
  restoredModelKey: null,
  restoredVideoModelKey: null,
  generatingCount: 0,
  restored: false,
  canUndo: false,
  canRedo: false,
};

let state: CanvasState = initialState;
const listeners = new Set<() => void>();
const objectURLCache = new Map<string, string>();
const abortControllers = new Map<string, AbortController>();
// 重查监听：上游任务仍在生成时每 3 秒回查一次状态，最多等待 10 分钟
// （与生成期视频轮询预算同一口径，超时后仍保留"重新查询"入口）。
const REQUERY_POLL_INTERVAL_MS = 3000;
const REQUERY_WAIT_LIMIT_MS = 10 * 60 * 1000;

// 等待下一次重查；节点被取消/离开时立即结束等待，不留悬挂的监听循环。
function waitForRequeryTick(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, REQUERY_POLL_INTERVAL_MS);
    function finish(): void {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
// 尚未注册 AbortController 的启动窗口（取 token/创建会话期间）收到的取消请求
const startAborts = new Set<string>();
let labels: CanvasStoreLabels | null = null;
let modelCatalog: CanvasModelOption[] = [];
let persistTimer: number | null = null;
let cloudPersist: ((raw: string) => void) | null = null;
let lastPersistedRaw = "";
// 上次推送到服务端的内容指纹（不含视口），用于区分「只有视口变化」而跳过云端写入
let lastCloudRaw = "";
// 本端已同步到的服务端版本（毫秒），仅内存态：跨会话由服务端内容重新建立
let syncedAt = 0;
let nodeSpawnCounter = 0;
type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };
const undoStack: GraphSnapshot[] = [];
const redoStack: GraphSnapshot[] = [];
let nodeMoveSnapshot: GraphSnapshot | null = null;
// 跨项目复制节点的剪贴板：内存保存完整运行时数据（含 objectURL），localStorage 兜底跨页面/刷新
const NODE_CLIPBOARD_KEY = "deeix-canvas-node-clipboard";
let nodeClipboardMemory: { nodes: GraphNode[]; edges: GraphEdge[] } | null = null;
const HISTORY_LIMIT = 100;

function cloneSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  return { nodes: snapshot.nodes.map((node) => ({ ...node })), edges: snapshot.edges.map((edge) => ({ ...edge })) };
}

function currentSnapshot(): GraphSnapshot {
  return { nodes: state.nodes, edges: state.edges };
}

function updateHistoryAvailability(): void {
  state = { ...state, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
}

function recordGraphHistory(snapshot: GraphSnapshot): void {
  undoStack.push(cloneSnapshot(snapshot));
  if (undoStack.length > HISTORY_LIMIT) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

function abortMissingNodes(nextNodes: GraphNode[]): void {
  const retained = new Set(nextNodes.map((node) => node.id));
  // 运行控制器按 runID 登记：输出节点仍在运行时其任务不随撤销中断
  for (const node of nextNodes) {
    if (node.kind === "output" && node.status === "running" && node.runID) {
      retained.add(node.runID);
    }
  }
  for (const [nodeID, controller] of abortControllers) {
    if (!retained.has(nodeID)) {
      controller.abort();
      abortControllers.delete(nodeID);
    }
  }
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

// 生成节点的上游行数派生：入端口逐个展示，每个端口至少占一行（未连接也要显示），
// 因此总行数 = 各端口「连接数取 max(1)」之和；端口锚点据此与清单行对齐
function normalizeGenerateRows<T extends { nodes: GraphNode[]; edges: GraphEdge[] }>(next: T): T {
  const perPort = new Map<string, Map<GraphPortID, number>>();
  for (const edge of next.edges) {
    const counts = perPort.get(edge.toNodeID) ?? new Map<GraphPortID, number>();
    counts.set(edge.toPort, (counts.get(edge.toPort) ?? 0) + 1);
    perPort.set(edge.toNodeID, counts);
  }
  let changed = false;
  const nodes = next.nodes.map((node) => {
    if (node.kind !== "generate") {
      return node;
    }
    const counts = perPort.get(node.id);
    const portRowCounts = graphNodePorts("generate", node.mediaType ?? "image")
      .filter((port) => port.direction === "in")
      .map((port) => Math.max(1, counts?.get(port.id) ?? 0));
    const totalRows = portRowCounts.reduce((sum, value) => sum + value, 0);
    if ((node.connectionRows ?? 0) === totalRows
      && (node.portRowCounts ?? []).join(",") === portRowCounts.join(",")) {
      return node;
    }
    changed = true;
    return { ...node, connectionRows: totalRows, portRowCounts };
  });
  return changed ? { ...next, nodes } : next;
}

function setState(updater: (current: CanvasState) => CanvasState): void {
  const next = updater(state);
  if (next === state) {
    return;
  }
  state = normalizeGenerateRows(next);
  emit();
  schedulePersist();
}

function reconcileFrameMembership(nodes: GraphNode[], decorations: CanvasDecoration[]) {
  const frames = decorations.filter((item) => item.kind === "frame");
  return {
    nodes: nodes.map((node) => ({
      ...node,
      frameID: stableFrameIDForGraphNode(node, frames),
    })),
    // 仅「组」承载内容；注释按中心点归属最近的组
    decorations: decorations.map((item) => item.kind === "frame" ? item : ({
      ...item,
      frameID: stableFrameIDForElement(item, frames),
    })),
  };
}

function stableFrameIDForGraphNode(node: GraphNode, frames: ReadonlyArray<CanvasDecoration>): string | null {
  const size = graphNodeSize(node);
  return stableFrameIDForElement({ ...node, width: size.width, height: size.height }, frames);
}

// 已合并进生成节点卡片的输出子节点：随来源生成节点一起删除/复制
function absorbedOutputIDs(nodes: ReadonlyArray<GraphNode>, removed: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "output" && node.sourceGenerateID && removed.has(node.sourceGenerateID)) {
      ids.add(node.id);
    }
  }
  return ids;
}

function dedupeReferences(items: ReadonlyArray<CanvasNodeReference>): CanvasNodeReference[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.fileID || seen.has(item.fileID)) {
      return false;
    }
    seen.add(item.fileID);
    return true;
  });
}

// 提示词内 @ 引用的素材与对话框上传的素材：按 MIME 归类为图像 / 视频 / 音频参考。
// 画布上已有的节点引用作为元数据来源，避免只拿到 fileID 却不知道媒体类型。
function promptAssetReferences(
  node: GenerateGraphNode,
  nodes: ReadonlyArray<GraphNode>,
  prompt: string,
): { images: CanvasNodeReference[]; videos: CanvasNodeReference[]; audios: CanvasNodeReference[] } {
  const index = new Map<string, CanvasNodeReference>();
  for (const asset of node.promptAssets ?? []) {
    index.set(asset.fileID, asset);
  }
  for (const item of nodes) {
    if (item.kind === "image" && item.reference) {
      index.set(item.reference.fileID, item.reference);
    }
    if (item.kind === "media" && item.reference) {
      index.set(item.reference.fileID, item.reference);
    }
    if (item.kind === "output" && item.status === "done" && item.fileID) {
      index.set(item.fileID, {
        fileID: item.fileID,
        fileName: item.fileName ?? "media",
        mimeType: item.mimeType ?? "",
        sizeBytes: item.sizeBytes ?? 0,
      });
    }
  }
  const ids = promptAssetFileIDs(prompt);
  for (const asset of node.promptAssets ?? []) {
    if (!ids.includes(asset.fileID)) {
      ids.push(asset.fileID);
    }
  }
  const result = {
    images: [] as CanvasNodeReference[],
    videos: [] as CanvasNodeReference[],
    audios: [] as CanvasNodeReference[],
  };
  for (const fileID of ids) {
    const reference = index.get(fileID);
    if (!reference) {
      continue;
    }
    const kind = canvasAssetKind(reference.mimeType, reference.fileName);
    if (kind === "image") {
      result.images.push(reference);
    } else if (kind === "video") {
      result.videos.push(reference);
    } else if (kind === "audio") {
      result.audios.push(reference);
    }
  }
  return result;
}

function clampScale(scale: number): number {
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, scale));
}

function currentPage(current: CanvasState): PersistedCanvasPage {
  const existing = current.canvases.find((item) => item.id === current.activeCanvasID);
  const now = Date.now();
  return {
    id: current.activeCanvasID, name: existing?.name ?? "Canvas", viewport: current.viewport,
    nodes: [], graphNodes: toPersistedGraphNodes(current.nodes), edges: toPersistedEdges(current.edges),
    decorations: current.decorations, bookmarks: current.bookmarks,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
}

function allPages(current: CanvasState): PersistedCanvasPage[] {
  const page = currentPage(current);
  return current.canvases.some((item) => item.id === page.id)
    ? current.canvases.map((item) => item.id === page.id ? page : item)
    : [...current.canvases, page];
}

function getPersistedState(): PersistedCanvasState {
  return {
    version: 4, projectName: state.projectName, activeCanvasID: state.activeCanvasID,
    canvases: allPages(state), versions: state.versions,
    conversationID: null, selectedModelName: state.restoredModelName,
    selectedVideoModelName: state.restoredVideoModelName,
    selectedModelKey: state.restoredModelKey,
    selectedVideoModelKey: state.restoredVideoModelKey, pointerMode: state.pointerMode,
    viewMode: state.viewMode,
    viewport: state.viewport, graphNodes: toPersistedGraphNodes(state.nodes), edges: toPersistedEdges(state.edges),
    decorations: state.decorations, bookmarks: state.bookmarks, imageOptions: {},
  };
}

// 云端快照统一使用的中性视口：视口是每台设备自己的浏览位置，
// 同步它会让「拖动画面」也产生云端写入，并可能把另一台设备的视角一起改掉
const CLOUD_NEUTRAL_VIEWPORT: CanvasViewport = { x: 0, y: 0, scale: 1 };

// 剥离视口后的快照：本地仍按完整快照落盘（刷新后视角不变），只有云端推送使用本函数
function cloudSnapshot(persisted: PersistedCanvasState): PersistedCanvasState {
  return {
    ...persisted,
    viewport: CLOUD_NEUTRAL_VIEWPORT,
    canvases: persisted.canvases?.map((page) => ({ ...page, viewport: CLOUD_NEUTRAL_VIEWPORT })),
  };
}

// 变更停止后延迟落盘；持续变更期间按上限强制落盘，限制丢失窗口
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_MAX_PENDING_MS = 5000;
let persistDirtyAt = 0;

function flushPersistInternal(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistDirtyAt = 0;
  const persisted = getPersistedState();
  const raw = stringifyCanvasState(persisted);
  if (raw === lastPersistedRaw) {
    return;
  }
  lastPersistedRaw = raw;
  saveCanvasState(persisted);
  // 只有视口变化时停止在这里：本地已落盘（刷新后视角保持），但不上云，
  // 否则拖动画面会用一次不必要的请求把服务端刷成同样内容
  const cloudRaw = stringifyCanvasState(cloudSnapshot(persisted));
  if (cloudRaw === lastCloudRaw) {
    return;
  }
  lastCloudRaw = cloudRaw;
  cloudPersist?.(cloudRaw);
}

function schedulePersist(): void {
  if (typeof window === "undefined" || !state.restored) {
    return;
  }
  const now = Date.now();
  if (persistTimer === null) {
    // 事件驱动防抖：只在变更停止后写入，而不是变更期间间歇性写入
    persistDirtyAt = now;
    persistTimer = window.setTimeout(flushPersistInternal, PERSIST_DEBOUNCE_MS);
  } else if (now - persistDirtyAt >= PERSIST_MAX_PENDING_MS) {
    // 长时间持续变更（如流式生成）时按上限强制落盘一次
    flushPersistInternal();
  }
}

function createNodeID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateNode(nodeID: string, updater: (node: GraphNode) => GraphNode): void {
  setState((current) => ({
    ...current,
    nodes: current.nodes.map((node) => (node.id === nodeID ? updater(node) : node)),
  }));
}

function resolveStatusLabel(status: string, fallback: string, mediaType: CanvasMediaType = "image"): string {
  const video = mediaType === "video";
  switch (status.trim()) {
    case "queued":
      return (video ? labels?.statusVideoQueued : labels?.statusQueued) ?? fallback;
    case "running":
      return (video ? labels?.statusVideoRunning : labels?.statusRunning) ?? fallback;
    case "saving_artifact":
      return (video ? labels?.statusVideoSavingArtifact : labels?.statusSavingArtifact) ?? fallback;
    case "progress": {
      const percent = fallback.match(/(\d+)\s*%/)?.[1];
      if (percent !== undefined && labels?.nodeProgress) {
        return labels.nodeProgress.replaceAll("{percent}", percent);
      }
      return fallback.trim() || status.trim();
    }
    default:
      return fallback.trim() || status.trim();
  }
}

// 运行收束后清除生成节点上的任务会话与运行引用：任务绑定随输出节点走
function clearGenerateNodeRunBinding(generateNodeID: string): void {
  updateNode(generateNodeID, (node) =>
    node.kind === "generate"
      ? { ...node, conversationID: undefined, runID: undefined }
      : node,
  );
}

// 生成节点进入失败态：保留配置，仅更新错误信息
function markGenerateNodeError(nodeID: string, errorMessage: string, errorDetail?: string): void {
  updateNode(nodeID, (node) => {
    if (node.kind !== "generate") {
      return node;
    }
    const next: GenerateGraphNode = {
      ...node,
      runStatus: "idle",
      statusLabel: undefined,
      previewURL: undefined,
      errorMessage,
      errorDetail,
      // 保留任务会话与运行 ID：错误节点可通过「重新查询」回查上游结果
      progress: undefined,
    };
    return next;
  });
}

function setGeneratingDelta(delta: number): void {
  setState((current) => ({
    ...current,
    generatingCount: Math.max(0, current.generatingCount + delta),
  }));
}

async function loadOutputImage(nodeID: string, fileID: string): Promise<void> {
  const cached = objectURLCache.get(fileID);
  if (cached) {
    // 本地预览已就绪：释放生成期的预览地址（可能是数 MB 的 base64）
    updateNode(nodeID, (node) => (node.kind === "output" ? { ...node, objectURL: cached, previewURL: undefined, imageLoadFailed: false } : node));
    return;
  }
  const token = await resolveAccessToken();
  if (!token) {
    updateNode(nodeID, (node) => (node.kind === "output" ? { ...node, imageLoadFailed: true } : node));
    return;
  }
  try {
    const result = await fetchFileContent(token, fileID);
    const objectURL = URL.createObjectURL(result.blob);
    objectURLCache.set(fileID, objectURL);
    updateNode(nodeID, (node) =>
      // 加载期间节点可能已被复用写入其他结果，避免旧图覆盖新引用
      node.kind === "output" && node.fileID === fileID
        ? { ...node, objectURL, previewURL: undefined, imageLoadFailed: false }
        : node,
    );
  } catch {
    updateNode(nodeID, (node) => (node.kind === "output" && node.fileID === fileID ? { ...node, imageLoadFailed: true } : node));
  }
}

// 参考素材节点：参考图节点与参考媒体节点共用「按 fileID 拉取预览」的逻辑
function isReferencePreviewNode(node: GraphNode): node is ImageGraphNode | MediaGraphNode {
  return node.kind === "image" || node.kind === "media";
}

// 参考素材节点预览加载：本地预览地址缺失（刷新恢复、跨节点拖入）时按 fileID 拉取
async function loadImageNodePreview(nodeID: string, fileID: string): Promise<void> {
  const cached = objectURLCache.get(fileID);
  if (cached) {
    updateNode(nodeID, (node) => (isReferencePreviewNode(node) && node.reference?.fileID === fileID
      ? { ...node, previewURL: cached, previewLoading: false, previewFailed: false }
      : node));
    return;
  }
  updateNode(nodeID, (node) => (isReferencePreviewNode(node) && node.reference?.fileID === fileID
    ? { ...node, previewLoading: true, previewFailed: false }
    : node));
  const token = await resolveAccessToken();
  if (!token) {
    updateNode(nodeID, (node) => (isReferencePreviewNode(node) && node.reference?.fileID === fileID
      ? { ...node, previewLoading: false, previewFailed: true }
      : node));
    return;
  }
  try {
    const result = await fetchFileContent(token, fileID);
    const objectURL = URL.createObjectURL(result.blob);
    objectURLCache.set(fileID, objectURL);
    updateNode(nodeID, (node) => (isReferencePreviewNode(node) && node.reference?.fileID === fileID
      ? { ...node, previewURL: objectURL, previewLoading: false, previewFailed: false }
      : node));
  } catch {
    updateNode(nodeID, (node) => (isReferencePreviewNode(node) && node.reference?.fileID === fileID
      ? { ...node, previewLoading: false, previewFailed: true }
      : node));
  }
}

// 新节点落点：视口中心附近轻微错位，避免完全重叠
function nextNodePosition(kind: GraphNodeKind, spawnPoint?: { x: number; y: number }): { x: number; y: number } {
  const offset = nodeSpawnCounter % 6;
  nodeSpawnCounter += 1;
  const size = GRAPH_NODE_SIZES[kind];
  const base = spawnPoint ?? { x: 0, y: 0 };
  return {
    x: Math.round(base.x - size.width / 2 + offset * 48),
    y: Math.round(base.y - size.height / 2 + offset * 40),
  };
}

// 拖到空白处自动补节点：按起拖端口推断应创建的节点，创建后立即连线。
// reverse 表示新节点在连线的「上游」（从入端口反向拖出）。
export type CanvasAutoConnectOption = {
  kind: GraphNodeKind;
  mediaType: CanvasNodeMediaHint;
  toPort: GraphInputPort;
  reverse: boolean;
};

// 候选创建类型：拖出后让用户选择要补哪种节点（未选择时不自动创建）
export function canvasAutoConnectOptions(drag: {
  fromPort: GraphPortID;
  fromDirection: "in" | "out";
  fromKind: GraphNodeKind;
  fromMediaKind?: CanvasMediaKind;
  fromMediaType?: CanvasMediaType;
}): CanvasAutoConnectOption[] {
  if (drag.fromDirection === "in") {
    switch (drag.fromPort) {
      case "prompt": return [{ kind: "prompt", mediaType: "image", toPort: "prompt", reverse: true }];
      case "image": return [{ kind: "image", mediaType: "image", toPort: "image", reverse: true }];
      case "video": return [{ kind: "media", mediaType: "video", toPort: "video", reverse: true }];
      case "audio": return [{ kind: "media", mediaType: "audio", toPort: "audio", reverse: true }];
      default: return [];
    }
  }
  switch (drag.fromKind) {
    case "prompt":
      return [
        { kind: "generate", mediaType: "image", toPort: "prompt", reverse: false },
        { kind: "generate", mediaType: "video", toPort: "prompt", reverse: false },
      ];
    case "image":
      return [
        { kind: "generate", mediaType: "image", toPort: "image", reverse: false },
        { kind: "generate", mediaType: "video", toPort: "image", reverse: false },
      ];
    case "media":
      return drag.fromMediaKind === "audio"
        ? [{ kind: "generate", mediaType: "video", toPort: "audio", reverse: false }]
        : [
          { kind: "generate", mediaType: "video", toPort: "video", reverse: false },
          { kind: "timeline", mediaType: "video", toPort: "video", reverse: false },
        ];
    case "generate":
    case "output":
      return drag.fromMediaType === "video"
        ? [
          { kind: "generate", mediaType: "video", toPort: "video", reverse: false },
          { kind: "timeline", mediaType: "video", toPort: "video", reverse: false },
        ]
        : [
          { kind: "generate", mediaType: "image", toPort: "image", reverse: false },
          { kind: "generate", mediaType: "video", toPort: "video", reverse: false },
        ];
    default:
      return [];
  }
}

function resolveAutoConnectPlan(drag: {
  fromPort: GraphPortID;
  fromDirection: "in" | "out";
  fromKind: GraphNodeKind;
  fromMediaKind?: CanvasMediaKind;
  fromMediaType?: CanvasMediaType;
}): CanvasAutoConnectOption | null {
  return canvasAutoConnectOptions(drag)[0] ?? null;
}

// 上游响应正文：服务端重新序列化后是单行 JSON，这里按 JSON 美化；非 JSON 原样返回
function formatUpstreamBody(body: string): string {
  const value = body.trim();
  if (!value) {
    return "";
  }
  const parsed = parseJSON(value);
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2);
}

// 上游响应抬头：有状态码时形如 "HTTP 502 upstream bad request"
function upstreamHeadline(statusCode: unknown, label: string): string {
  const status = isFiniteNumber(statusCode) ? `HTTP ${statusCode}` : "";
  return [status, label.trim()].filter(Boolean).join(" ");
}

function contextLine(label: string, value: string | undefined): string {
  return value ? `${label}: ${value}` : "";
}

function joinDetailLines(lines: ReadonlyArray<string>): string | undefined {
  return lines.map((line) => line.trim()).filter(Boolean).join("\n\n") || undefined;
}

// 错误详情归一化为可读文本，按信息量排序：
// ① HTTP 错误的结构化详情 details.upstream（上游状态码 + 脱敏正文）
// ② 会话流错误的脱敏调试快照 details.response（同一份内容，字段布局不同）
// ③ 媒体任务被前置校验拦下时的定位上下文 details.context（哪个运行 / 什么任务 / 哪个协议 / 哪个上游）
// ④ 回退到后端原始文案与错误码
function errorDetailFromApiError(error: ApiError): string | undefined {
  const details = isRecord(error.details) ? error.details : null;
  const upstream = details && isRecord(details.upstream) ? details.upstream : null;
  if (upstream) {
    return joinDetailLines([
      upstreamHeadline(upstream.statusCode, readString(upstream, "message") ?? ""),
      formatUpstreamBody(readString(upstream, "body") ?? ""),
    ]);
  }
  const snapshot = details && isRecord(details.response) ? details.response : null;
  if (snapshot) {
    const request = details && isRecord(details.request) ? details.request : {};
    const target = [readString(request, "method") ?? "", readString(request, "path") ?? ""].filter(Boolean).join(" ");
    return joinDetailLines([
      upstreamHeadline(snapshot.statusCode, target),
      formatUpstreamBody(readString(snapshot, "body") ?? ""),
    ]);
  }
  const context = details && isRecord(details.context) ? details.context : null;
  if (context) {
    return joinDetailLines([
      contextLine("runID", readString(context, "runID")),
      contextLine("taskType", readString(context, "taskType")),
      contextLine("protocol", readString(context, "protocol")),
      contextLine("upstreamID", isFiniteNumber(context.upstreamID) ? String(context.upstreamID) : undefined),
      contextLine("upstreamTaskID", readString(context, "upstreamTaskID")),
      contextLine("status", readString(context, "status")),
    ]);
  }
  return joinDetailLines([error.rawMessage?.trim() || "", error.errorCode ? `errorCode: ${error.errorCode}` : ""]);
}

function hydrateNodeImages(nodes: ReadonlyArray<GraphNode>): void {
  for (const node of nodes) {
    if (node.kind === "output" && node.status === "done" && node.fileID) {
      void loadOutputImage(node.id, node.fileID);
    }
    if (isReferencePreviewNode(node) && node.reference && !node.previewURL && !node.previewLoading) {
      void loadImageNodePreview(node.id, node.reference.fileID);
    }
  }
}

// Frame 成员变化检测所需的元素列表：节点补齐固定尺寸，装饰自带宽高
function frameRefitElements(nodes: ReadonlyArray<GraphNode>, decorations: ReadonlyArray<CanvasDecoration>): FrameRefitElement[] {
  return [
    ...nodes.map((node) => {
      const size = graphNodeSize(node);
      return { id: node.id, x: node.x, y: node.y, width: size.width, height: size.height, frameID: node.frameID };
    }),
    ...decorations.map((item) => ({ id: item.id, x: item.x, y: item.y, width: item.width, height: item.height, frameID: item.frameID })),
  ];
}

// 快照是否承载任何实际内容（节点/装饰）。空快照绝不覆盖本地已有内容：
// 云端一旦被误写为空，直接采纳会让画布随机变空
function persistedStateHasContent(persisted: PersistedCanvasState): boolean {
  const pageHasContent = (page: PersistedCanvasPage): boolean =>
    (page.graphNodes?.length ?? 0) > 0 || (page.nodes?.length ?? 0) > 0 || (page.decorations?.length ?? 0) > 0;
  return (persisted.graphNodes?.length ?? 0) > 0 || (persisted.canvases ?? []).some(pageHasContent);
}

// 使用模式默认值：窄屏（lg 断点以下，与移动端对话输入条一致）默认对话模式，其余节点图
function defaultCanvasViewMode(): CanvasViewMode {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "graph";
  }
  return window.matchMedia("(max-width: 1023px)").matches ? "chat" : "graph";
}

// viewportOverride 用于采纳云端快照时保留本端视角（云端快照不携带视口）
function restoreFromPersisted(persisted: PersistedCanvasState, viewportOverride?: CanvasViewport): void {
  const canvases = persisted.canvases ?? [];
  const activeCanvasID = persisted.activeCanvasID ?? canvases[0]?.id ?? "canvas-main";
  const active = canvases.find((item) => item.id === activeCanvasID);
  const restoredNodes = restoreGraphNodes(active?.graphNodes ?? persisted.graphNodes ?? []);
  const restoredEdges = restoreEdges(active?.edges ?? persisted.edges ?? [], restoredNodes);
  const restoredDecorations = active?.decorations ?? persisted.decorations ?? [];
  const reconciled = reconcileFrameMembership(restoredNodes, restoredDecorations);
  nodeSpawnCounter = restoredNodes.length;
  undoStack.length = 0;
  redoStack.length = 0;
  state = {
    ...state, nodes: reconciled.nodes, edges: restoredEdges, decorations: reconciled.decorations,
    bookmarks: active?.bookmarks ?? persisted.bookmarks ?? [], canvases, activeCanvasID,
    projectName: persisted.projectName ?? "Untitled project", versions: persisted.versions ?? [],
    viewport: viewportOverride
      ?? { ...(active?.viewport ?? persisted.viewport), scale: clampScale((active?.viewport ?? persisted.viewport).scale) },
    conversationID: null, pointerMode: persisted.pointerMode,
    viewMode: persisted.viewMode ?? defaultCanvasViewMode(),
    restoredModelName: persisted.selectedModelName,
    restoredVideoModelName: persisted.selectedVideoModelName ?? null,
    restoredModelKey: persisted.selectedModelKey ?? null,
    restoredVideoModelKey: persisted.selectedVideoModelKey ?? null,
    selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [],
    restored: true, canUndo: false, canRedo: false,
  };
  lastPersistedRaw = stringifyCanvasState(persisted);
  emit();
  hydrateNodeImages(restoredNodes);
}

// 每个画布任务使用独立会话，避免 Chat 路由自动继承上一张图的提示词上下文。
// 请求结束后会软删除该会话但保留生成文件，左侧对话列表不会累积画布记录。
async function createTaskConversation(token: string): Promise<string> {
  const conversation = await createConversation(token, {
    title: labels?.conversationTitle ?? "Canvas",
  });
  return conversation.publicID;
}

// 生成结果落位条目：成功产物携带文件信息，保存待重试产物携带输出节点的重试引用。
type GenerateResultEntry = {
  fileID?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  pendingRetry?: OutputPendingRetry;
};

// 任务创建时立即分配输出节点：优先复用已连接的空闲输出节点，不足时在生成节点右侧
// 派生新节点并连线（与 writeGenerateResults 的落位规则一致）。分配出的节点立刻进入
// running 态承接任务等待/进度/取消，生成节点不再承载运行状态。
function allocateOutputTargets(generateNode: GenerateGraphNode, count: number): string[] {
  if (count <= 0) {
    return [];
  }
  const mediaType = generateNode.mediaType ?? "image";
  const size = GRAPH_NODE_SIZES.output;
  const generateSize = graphNodeSize(generateNode);
  const outputX = generateNode.x + generateSize.width + 96;

  const allocated = setStateWithMutation<string[]>((current) => {
    const connectedTargets = current.edges
      .filter((edge) => edge.fromNodeID === generateNode.id && edge.toPort === "result")
      .map((edge) => current.nodes.find((node) => node.id === edge.toNodeID))
      .filter((node): node is OutputGraphNode => node?.kind === "output")
      .filter((node) => (!node.mediaType || node.mediaType === mediaType) && node.status === "empty")
      .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));

    const targets = connectedTargets.slice(0, count);
    const bottomY = connectedTargets.length > 0
      ? Math.max(...connectedTargets.map((target) => target.y + size.height))
      : generateNode.y + Math.round((generateSize.height - size.height) / 2);
    let nextSpawnY = bottomY;
    const spawned: OutputGraphNode[] = [];
    const nodes = [...current.nodes];
    const edges = [...current.edges];
    while (targets.length + spawned.length < count) {
      const outputID = createNodeID();
      const outputNode: OutputGraphNode = {
        id: outputID, kind: "output", mediaType,
        x: outputX,
        y: nextSpawnY,
        createdAt: Date.now(), status: "empty",
      };
      nextSpawnY += size.height + 32;
      nodes.push(outputNode);
      edges.push({ id: createNodeID(), fromNodeID: generateNode.id, toNodeID: outputID, toPort: "result", createdAt: Date.now() });
      spawned.push(outputNode);
    }

    // 生成节点被 Frame 承载时，Frame 自动向外扩展以容纳派生的输出节点并纳入承载
    let decorations = current.decorations;
    if (spawned.length > 0 && generateNode.frameID) {
      const frame = decorations.find((item) =>
        item.id === generateNode.frameID && item.kind === "frame" && !item.locked && !item.collapsed);
      if (frame) {
        const spawnedElements: FrameRefitElement[] = spawned.map((output) => ({
          id: output.id, x: output.x, y: output.y, width: size.width, height: size.height,
        }));
        decorations = decorations.map((item) =>
          item.id === frame.id ? { ...item, ...frameUnionBounds(item, spawnedElements) } : item);
        for (const output of spawned) {
          output.frameID = frame.id;
        }
      }
    }

    // 已连接但未入选的空输出节点保持原样；入选节点与派生节点统一进入 running 态
    const targetIDs = new Set([...targets, ...spawned].map((node) => node.id));
    const updatedNodes = nodes.map((node) => {
      if (node.kind !== "output" || !targetIDs.has(node.id)) {
        return node;
      }
      const next: OutputGraphNode = {
        ...node,
        status: "running",
        mediaType,
        prompt: undefined,
        model: undefined,
        fileID: undefined, fileName: undefined, mimeType: undefined, sizeBytes: undefined,
        objectURL: undefined, imageLoadFailed: false,
        errorMessage: undefined, errorDetail: undefined, pendingRetry: undefined, retrySaving: false,
        completedAt: undefined, durationMs: undefined, durationSeconds: undefined,
        sourceGenerateID: generateNode.id,
        statusLabel: labels?.nodePreparing ?? "",
        previewURL: undefined, progress: undefined,
      };
      return next;
    });

    return {
      result: [...targetIDs],
      nextState: {
        ...current,
        nodes: updatedNodes,
        edges,
        decorations,
      } satisfies CanvasState,
    };
  });
  return allocated;
}

// 通用状态变更：updater 返回业务结果与下一状态，统一走 setState 触发监听与持久化
function setStateWithMutation<T>(updater: (current: CanvasState) => { result: T; nextState: CanvasState }): T {
  let captured: T | undefined;
  setState((current) => {
    const { result, nextState } = updater(current);
    captured = result;
    return nextState;
  });
  return captured as T;
}

// 生成结果写入任务预分配的输出节点（运行状态所在节点）：按序填充，多余节点复位为空，
// 结果多于节点时在最后一个目标下方派生新输出节点承接（并连线回来源生成节点）。
function writeResultsIntoTargets(
  targetIDs: ReadonlyArray<string>,
  entries: GenerateResultEntry[],
  context: { prompt: string; modelName: string; durationMs?: number; durationSeconds?: number; savePendingLabel?: string },
): void {
  const completedAt = Date.now();
  const writeEntry = (node: OutputGraphNode, entry: GenerateResultEntry | undefined): OutputGraphNode => {
    if (!entry) {
      // 目标多于结果：复位为空状态
      return {
        ...node, status: "empty",
        fileID: undefined, fileName: undefined, mimeType: undefined, sizeBytes: undefined,
        objectURL: undefined, imageLoadFailed: false,
        errorMessage: undefined, errorDetail: undefined, pendingRetry: undefined, retrySaving: false,
        statusLabel: undefined, previewURL: undefined, progress: undefined,
        conversationID: undefined, runID: undefined,
      };
    }
    if (entry.pendingRetry) {
      // 保存待重试：生成已成功，本节点持有重试引用，保存失败不占用生成节点状态
      return {
        ...node, status: "error",
        fileID: undefined, fileName: undefined, mimeType: undefined, sizeBytes: undefined,
        objectURL: undefined, imageLoadFailed: false,
        prompt: context.prompt, model: context.modelName,
        errorMessage: context.savePendingLabel ?? "",
        errorDetail: undefined, completedAt,
        durationMs: context.durationMs, durationSeconds: undefined,
        statusLabel: undefined, previewURL: undefined, progress: undefined,
        conversationID: undefined,
        pendingRetry: entry.pendingRetry,
      };
    }
    return {
      ...node, status: "done",
      fileID: entry.fileID, fileName: entry.fileName,
      mimeType: entry.mimeType, sizeBytes: entry.sizeBytes, objectURL: undefined,
      imageLoadFailed: false, prompt: context.prompt, model: context.modelName,
      errorMessage: undefined, errorDetail: undefined, completedAt,
      durationMs: context.durationMs,
      durationSeconds: entry.durationSeconds ?? context.durationSeconds,
      statusLabel: undefined, previewURL: undefined, progress: undefined,
      conversationID: undefined, runID: undefined, pendingRetry: undefined, retrySaving: false,
    };
  };

  const newNodeIDs = setStateWithMutation<string[]>((current) => {
    const targets = targetIDs
      .map((id) => current.nodes.find((node) => node.id === id))
      .filter((node): node is OutputGraphNode => node?.kind === "output");
    const nodes = [...current.nodes];
    const edges = [...current.edges];
    const filledIDs = [...targets.map((node) => node.id)];
    const size = GRAPH_NODE_SIZES.output;

    // 结果多于预分配目标：在最后一个目标下方派生输出节点承接
    let lastY = targets.length > 0 ? targets[targets.length - 1].y : 0;
    const lastX = targets.length > 0 ? targets[targets.length - 1].x : 0;
    let sourceGenerateID: string | null = targets[0]?.sourceGenerateID ?? null;
    while (filledIDs.length < entries.length) {
      const outputID = createNodeID();
      const outputNode: OutputGraphNode = {
        id: outputID, kind: "output",
        mediaType: entries[filledIDs.length].pendingRetry?.mediaType ?? "image",
        x: lastX,
        y: lastY + size.height + 32,
        createdAt: Date.now(), status: "empty",
        sourceGenerateID,
      };
      lastY = outputNode.y;
      nodes.push(outputNode);
      if (sourceGenerateID) {
        edges.push({ id: createNodeID(), fromNodeID: sourceGenerateID, toNodeID: outputID, toPort: "result", createdAt: Date.now() });
      }
      filledIDs.push(outputID);
    }

    const updatedNodes = nodes.map((node) => {
      if (node.kind !== "output") {
        return node;
      }
      const index = filledIDs.indexOf(node.id);
      if (index < 0) {
        return node;
      }
      return writeEntry(node, entries[index]);
    });

    return {
      result: filledIDs,
      nextState: { ...current, nodes: updatedNodes, edges } satisfies CanvasState,
    };
  });

  // 结果落位后加载图像预览（仅限尚无预览的节点，已完成节点不重复加载）
  const after = state.nodes.filter((node): node is OutputGraphNode =>
    node.kind === "output" && node.status === "done" && newNodeIDs.includes(node.id)
    && Boolean(node.fileID) && !node.objectURL);
  for (const node of after) {
    if (node.fileID) {
      void loadOutputImage(node.id, node.fileID);
    }
  }
}

// 将生成结果写入下游输出节点：优先复用已连接的输出节点（重复生成时覆盖写入同一节点，
// 不再派生新节点），连接数量不足时才在生成节点右侧派生新的输出节点并连线。
// 视频结果只能写入视频/中立输出节点，图像结果只能写入图像/中立输出节点。
// 保存待重试的产物同样落位为输出节点（error 态 + 重试引用），保存职责归输出节点自治。
function writeGenerateResults(
  generateNode: GenerateGraphNode,
  entries: GenerateResultEntry[],
  context: { prompt: string; modelName: string; durationMs?: number; durationSeconds?: number; savePendingLabel?: string },
): void {
  const mediaType = generateNode.mediaType ?? "image";
  const size = GRAPH_NODE_SIZES.output;
  const generateSize = graphNodeSize(generateNode);
  setState((current) => {
    const connectedTargets = current.edges
      .filter((edge) => edge.fromNodeID === generateNode.id && edge.toPort === "result")
      .map((edge) => current.nodes.find((node) => node.id === edge.toNodeID))
      .filter((node): node is OutputGraphNode => node?.kind === "output")
      .filter((node) => !node.mediaType || node.mediaType === mediaType)
      .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));

    const nodes: GraphNode[] = [...current.nodes];
    const edges: GraphEdge[] = [...current.edges];
    const completedAt = Date.now();

    // 只复用仍为空的输出节点承接本次结果；已有结果的输出节点保留原内容不覆盖，
    // 运行中的输出节点不可占用，不足的结果派生新的输出节点，让多次生成的结果在画布上共存。
    const reusableTargets = connectedTargets.filter((node) => !(node.status === "done" && node.fileID) && node.status !== "running");
    const targets: OutputGraphNode[] = reusableTargets.slice(0, entries.length);
    const outputX = generateNode.x + generateSize.width + 96;
    const bottomY = connectedTargets.length > 0
      ? Math.max(...connectedTargets.map((target) => target.y + size.height))
      : generateNode.y + Math.round((generateSize.height - size.height) / 2);
    let nextSpawnY = bottomY;
    const spawned: OutputGraphNode[] = [];
    while (targets.length < entries.length) {
      const outputID = createNodeID();
      const outputNode: OutputGraphNode = {
        id: outputID, kind: "output", mediaType,
        x: outputX,
        y: nextSpawnY,
        createdAt: Date.now(), status: "empty",
      };
      nextSpawnY += size.height + 32;
      nodes.push(outputNode);
      edges.push({ id: createNodeID(), fromNodeID: generateNode.id, toNodeID: outputID, toPort: "result", createdAt: Date.now() });
      targets.push(outputNode);
      spawned.push(outputNode);
    }

    // 生成节点被 Frame 承载时，Frame 自动向外扩展以容纳派生的输出节点并纳入承载
    let decorations = current.decorations;
    if (spawned.length > 0 && generateNode.frameID) {
      const frame = current.decorations.find((item) =>
        item.id === generateNode.frameID && item.kind === "frame" && !item.locked && !item.collapsed);
      if (frame) {
        const spawnedElements: FrameRefitElement[] = spawned.map((output) => ({
          id: output.id, x: output.x, y: output.y, width: size.width, height: size.height,
        }));
        decorations = decorations.map((item) =>
          item.id === frame.id ? { ...item, ...frameUnionBounds(item, spawnedElements) } : item);
        for (const output of spawned) {
          output.frameID = frame.id;
        }
      }
    }

    const targetIDs = new Set(targets.map((target) => target.id));
    const updatedNodes = nodes.map((node) => {
      // 先收窄为输出节点，再匹配本次生成的落位目标（未入选的节点保持原样）
      if (node.kind !== "output" || !targetIDs.has(node.id)) {
        return node;
      }
      const targetIndex = targets.findIndex((target) => target.id === node.id);
      const entry = entries[targetIndex];
      const next: OutputGraphNode = entry?.pendingRetry
        // 保存待重试：生成已成功，本节点持有重试引用，保存失败不占用生成节点状态
        ? {
          ...node, status: "error", mediaType, fileID: undefined, fileName: undefined,
          mimeType: undefined, sizeBytes: undefined, objectURL: undefined, imageLoadFailed: false,
          prompt: context.prompt, model: context.modelName,
          sourceGenerateID: generateNode.id,
          errorMessage: context.savePendingLabel ?? "",
          errorDetail: undefined, completedAt,
          durationMs: context.durationMs, durationSeconds: undefined,
          pendingRetry: entry.pendingRetry,
        }
        : entry
          ? {
            ...node, status: "done", mediaType, fileID: entry.fileID, fileName: entry.fileName,
            mimeType: entry.mimeType, sizeBytes: entry.sizeBytes, objectURL: undefined,
            imageLoadFailed: false, prompt: context.prompt, model: context.modelName,
            sourceGenerateID: generateNode.id, errorMessage: undefined, errorDetail: undefined,
            completedAt, durationMs: context.durationMs,
            durationSeconds: entry.durationSeconds ?? context.durationSeconds,
            pendingRetry: undefined,
          }
          // 输出节点多于结果时重置为空状态
          : { ...node, status: "empty", fileID: undefined, fileName: undefined, mimeType: undefined, sizeBytes: undefined, objectURL: undefined, imageLoadFailed: false, errorMessage: undefined, errorDetail: undefined, sourceGenerateID: generateNode.id, pendingRetry: undefined };
      return next;
    });

    return {
      ...current,
      nodes: updatedNodes,
      edges,
      decorations,
      selectedNodeIDs: current.selectedNodeIDs,
    };
  });

  // 结果落位后加载图像预览（仅限尚无预览的节点，已完成节点不重复加载）
  const after = state.nodes.filter((node): node is OutputGraphNode =>
    node.kind === "output" && node.status === "done" && node.sourceGenerateID === generateNode.id
    && Boolean(node.fileID) && !node.objectURL);
  for (const node of after) {
    if (node.fileID) {
      void loadOutputImage(node.id, node.fileID);
    }
  }
}

// 媒体增量按序号对应输出节点；序号缺失或越界时退回全部运行中的节点。
function mediaDeltaTargets(outputNodeIDs: ReadonlyArray<string>, index: number | undefined): ReadonlyArray<string> {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= outputNodeIDs.length) {
    return outputNodeIDs;
  }
  return [outputNodeIDs[index]];
}

// 流事件回调构建：媒体状态（含视频进度百分比）与图像增量预览写入运行中的输出节点。
// 任务创建即转交输出节点：等待/流式响应/进度都在输出节点上呈现，生成节点不再承载运行状态。
// 产物待重试（media_artifact_pending）由会话流层统一分派，画布只需提供回调。
function buildStreamOptions(
  outputNodeIDs: ReadonlyArray<string>,
  mediaType: CanvasMediaType,
  signal: AbortSignal | undefined,
  extra: {
    onDelta?: (delta: string) => void;
    onMediaArtifactPending?: (event: MediaArtifactPendingEvent) => void;
  } = {},
): ConversationStreamOptions {
  const updateRunningOutputs = (updater: (node: OutputGraphNode) => OutputGraphNode): void => {
    for (const nodeID of outputNodeIDs) {
      updateNode(nodeID, (node) =>
        node.kind === "output" && node.status === "running" ? updater(node) : node,
      );
    }
  };
  return {
    signal,
    onMediaArtifactPending: extra.onMediaArtifactPending,
    onMediaStatus: (event) => {
      const label = resolveStatusLabel(event.status, event.message, mediaType);
      updateRunningOutputs((node) => {
        // 进入落盘阶段说明上游生成已结束：直接置满，避免轮询提前收尾时进度条定格在半截百分比
        const percent = event.status === "saving_artifact"
          ? 100
          : event.status === "progress"
            ? Number(event.message.match(/(\d+)\s*%/)?.[1] ?? NaN)
            : NaN;
        return {
          ...node,
          statusLabel: label,
          progress: Number.isFinite(percent) ? percent : node.progress,
        };
      });
    },
    onMediaImageDelta: (event) => {
      const b64 = (event.b64_json ?? "").trim();
      const source = b64
        ? b64.startsWith("data:")
          ? b64
          : `data:${event.mime_type?.trim() || "image/png"};base64,${b64}`
        : (event.url ?? "").trim();
      if (!source) {
        return;
      }
      // 多图任务按序号落到各自输出节点，避免同一张预览覆盖所有结果位
      for (const nodeID of mediaDeltaTargets(outputNodeIDs, event.index)) {
        updateNode(nodeID, (node) =>
          node.kind === "output" && node.status === "running" ? { ...node, previewURL: source } : node,
        );
      }
    },
    onDelta: extra.onDelta,
    onModerationBlocked: () => {
      markOutputTargetsError(outputNodeIDs, labels?.moderationBlocked ?? "");
    },
  };
}

// 运行中的输出节点批量进入失败态：保留任务引用（runID 供重查），清除瞬态展示字段
function markOutputTargetsError(
  outputNodeIDs: ReadonlyArray<string>,
  errorMessage: string,
  errorDetail?: string,
): void {
  for (const nodeID of outputNodeIDs) {
    updateNode(nodeID, (node) => {
      if (node.kind !== "output" || node.status !== "running") {
        return node;
      }
      return {
        ...node,
        status: "error",
        statusLabel: undefined,
        previewURL: undefined,
        progress: undefined,
        errorMessage,
        errorDetail,
        // 会话在失败后即被清理，仅保留 runID 供「重新查询」回查上游结果
        conversationID: undefined,
      };
    });
  }
}

const canvasStoreImplementation = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): CanvasState {
    return state;
  },

  getServerState(): CanvasState {
    return initialState;
  },

  setLabels(next: CanvasStoreLabels): void {
    labels = next;
  },

  setCloudPersist(next: ((raw: string) => void) | null): void {
    cloudPersist = next;
  },

  // 立即完成挂起的持久化并推送云端（页面隐藏/关闭时的防抖丢尾兜底）
  flushPersist(): void {
    if (typeof window === "undefined" || !state.restored) {
      return;
    }
    flushPersistInternal();
  },

  // 是否有未落盘的变更：云端拉取期间存在未保存变更时跳过，防止覆盖本端编辑
  hasUnsavedChanges(): boolean {
    return persistTimer !== null;
  },

  // 模型目录由组件层注入，供生成节点按名称解析运行时模型
  setModelCatalog(models: CanvasModelOption[]): void {
    modelCatalog = models;
  },

  // 按身份键（优先）与模型名解析目录中的模型：同一名称可能存在于多个接口，
  // 用户模型以 userModelID 精确定位，平台模型按名称匹配
  resolveModel(
    modelName: string | null,
    mediaType: CanvasMediaType = "image",
    modelScope?: "platform" | "user",
    userModelID?: number,
  ): CanvasModelOption | null {
    if (modelCatalog.length === 0) {
      return null;
    }
    const scoped = modelCatalog.filter((item) => modelCanvasMediaType(item) === mediaType);
    const candidates = scoped.length > 0 ? scoped : modelCatalog;
    if (modelScope === "user" && userModelID) {
      const byUserModelID = candidates.find((item) => item.modelScope === "user" && item.userModelID === userModelID);
      if (byUserModelID) {
        return byUserModelID;
      }
    }
    if (modelName) {
      const byNameInScope = candidates.find(
        (item) => item.platformModelName === modelName && (item.modelScope ?? "platform") === (modelScope ?? "platform"),
      );
      if (byNameInScope) {
        return byNameInScope;
      }
      const byName = candidates.find((item) => item.platformModelName === modelName);
      if (byName) {
        return byName;
      }
    }
    return candidates[0];
  },

  // 采用服务端快照。服务端是唯一权威：本端不再用本地时钟推断新旧，
  // 因此不存在"时间戳误判导致拒绝采纳"或"多端互相抬升时间戳"的问题。
  seedPersistedState(persisted: PersistedCanvasState): void {
    // 内存态必须先从本地恢复：空快照保护要基于真实本地内容判断
    if (!state.restored) {
      canvasStore.restore();
    }
    // 空快照不回灌：云端一旦被误写为空，采纳会让画布凭空消失，
    // 此时保留本地内容并把它回推云端，让服务端恢复到有内容的状态
    if (!persistedStateHasContent(persisted)) {
      const local = loadCanvasState();
      if (local && persistedStateHasContent(local)) {
        canvasStore.pushCurrentStateToCloud();
      }
      return;
    }
    // 云端快照不携带视口：采纳内容时保留本端视角，否则每次同步都会把画面重置
    const localViewport = state.viewport;
    restoreFromPersisted(persisted, localViewport);
    // 本地缓存跟随云端：下次冷启动先展示的就是服务端最新内容
    const next = getPersistedState();
    lastPersistedRaw = stringifyCanvasState(next);
    lastCloudRaw = stringifyCanvasState(cloudSnapshot(next));
    saveCanvasState(next);
  },

  pushCurrentStateToCloud(): void {
    // 未恢复的内存态是空画布：直接推送会用空快照覆盖云端真实内容（数据丢失）
    if (!state.restored) {
      canvasStore.restore();
    }
    const cloudRaw = stringifyCanvasState(cloudSnapshot(getPersistedState()));
    lastCloudRaw = cloudRaw;
    cloudPersist?.(cloudRaw);
  },

  // 记录本端已同步到的服务端版本：拉取时据此判断云端是否被其他设备更新过
  markSynced(updatedAt: number): void {
    if (Number.isFinite(updatedAt) && updatedAt > syncedAt) {
      syncedAt = updatedAt;
    }
  },

  getSyncedAt(): number {
    return syncedAt;
  },

  // 首次进入时从 localStorage 恢复；后续路由切换直接复用内存状态
  restore(): void {
    if (state.restored) {
      return;
    }
    const persisted = loadCanvasState();
    if (!persisted) {
      const now = Date.now();
      const page: PersistedCanvasPage = { id: "canvas-main", name: "Canvas 1", viewport: state.viewport, nodes: [], graphNodes: [], edges: [], decorations: [], bookmarks: [], createdAt: now, updatedAt: now };
      setState((current) => ({ ...current, canvases: [page], activeCanvasID: page.id, restored: true, viewMode: defaultCanvasViewMode() }));
      return;
    }
    restoreFromPersisted(persisted);
  },

  setViewport(next: CanvasViewport | ((current: CanvasViewport) => CanvasViewport)): void {
    setState((current) => ({
      ...current,
      viewport: typeof next === "function" ? next(current.viewport) : next,
    }));
  },

  resetViewport(): void {
    setState((current) => ({ ...current, viewport: { x: 0, y: 0, scale: 1 } }));
  },

  fitViewport(containerSize: { width: number; height: number }): void {
    if ((state.nodes.length === 0 && state.decorations.length === 0) || containerSize.width <= 0 || containerSize.height <= 0) {
      canvasStore.resetViewport();
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of state.nodes) {
      const size = graphNodeSize(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + size.width);
      maxY = Math.max(maxY, node.y + size.height);
    }
    for (const decoration of state.decorations) {
      minX = Math.min(minX, decoration.x);
      minY = Math.min(minY, decoration.y);
      maxX = Math.max(maxX, decoration.x + decoration.width);
      maxY = Math.max(maxY, decoration.y + decoration.height);
    }
    const boundsWidth = Math.max(1, maxX - minX);
    const boundsHeight = Math.max(1, maxY - minY);
    const padding = 80;
    const scale = clampScale(
      Math.min(
        (containerSize.width - padding * 2) / boundsWidth,
        (containerSize.height - padding * 2) / boundsHeight,
      ),
    );
    setState((current) => ({
      ...current,
      viewport: {
        x: (containerSize.width - boundsWidth * scale) / 2 - minX * scale,
        y: (containerSize.height - boundsHeight * scale) / 2 - minY * scale,
        scale,
      },
    }));
  },

  setPointerMode(mode: CanvasPointerMode): void {
    setState((current) => (current.pointerMode === mode ? current : { ...current, pointerMode: mode }));
  },

  setViewMode(mode: CanvasViewMode): void {
    setState((current) => (current.viewMode === mode ? current : { ...current, viewMode: mode }));
  },

  setSelectedNodeIDs(nodeIDs: string[]): void {
    setState((current) => {
      const nextEdges = current.selectedEdgeIDs.length > 0 ? { selectedEdgeIDs: [] as string[] } : null;
      if (current.selectedNodeIDs.length === nodeIDs.length && current.selectedNodeIDs.every((id, index) => id === nodeIDs[index])) {
        return nextEdges ? { ...current, ...nextEdges } : current;
      }
      return { ...current, selectedNodeIDs: nodeIDs, ...(nextEdges ?? {}) };
    });
  },

  setSelectedDecorationIDs(ids: string[]): void {
    setState((current) => current.selectedDecorationIDs.length === ids.length && current.selectedDecorationIDs.every((id, index) => id === ids[index])
      ? current
      : { ...current, selectedDecorationIDs: ids });
  },

  setSelectedEdgeIDs(edgeIDs: string[]): void {
    setState((current) => current.selectedEdgeIDs.length === edgeIDs.length && current.selectedEdgeIDs.every((id, index) => id === edgeIDs[index])
      ? current
      : { ...current, selectedEdgeIDs: edgeIDs });
  },

  setProjectName(name: string): void {
    setState((current) => current.projectName === name ? current : { ...current, projectName: name });
  },

  addCanvas(name?: string): void {
    const pages = allPages(state);
    const now = Date.now();
    const id = createNodeID();
    const page: PersistedCanvasPage = { id, name: name?.trim() || `Canvas ${pages.length + 1}`, viewport: { x: 0, y: 0, scale: 1 }, nodes: [], graphNodes: [], edges: [], decorations: [], bookmarks: [], createdAt: now, updatedAt: now };
    setState((current) => ({ ...current, canvases: [...pages, page], activeCanvasID: id, nodes: [], edges: [], decorations: [], bookmarks: [], viewport: page.viewport, selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [] }));
  },

  switchCanvas(canvasID: string): void {
    if (canvasID === state.activeCanvasID || state.generatingCount > 0) return;
    const pages = allPages(state);
    const target = pages.find((item) => item.id === canvasID);
    if (!target) return;
    const nodes = restoreGraphNodes(target.graphNodes ?? []);
    const edges = restoreEdges(target.edges ?? [], nodes);
    setState((current) => ({ ...current, canvases: pages, activeCanvasID: canvasID, nodes, edges, decorations: target.decorations, bookmarks: target.bookmarks, viewport: target.viewport, selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [] }));
    hydrateNodeImages(nodes);
  },

  renameCanvas(canvasID: string, name: string): void {
    setState((current) => ({ ...current, canvases: allPages(current).map((item) => item.id === canvasID ? { ...item, name } : item) }));
  },

  removeCanvas(canvasID: string): void {
    const pages = allPages(state);
    if (pages.length <= 1 || state.generatingCount > 0) return;
    const remaining = pages.filter((item) => item.id !== canvasID);
    const target = canvasID === state.activeCanvasID ? remaining[0] : pages.find((item) => item.id === state.activeCanvasID) ?? remaining[0];
    const nodes = restoreGraphNodes(target.graphNodes ?? []);
    const edges = restoreEdges(target.edges ?? [], nodes);
    setState((current) => ({ ...current, canvases: remaining, activeCanvasID: target.id, nodes, edges, decorations: target.decorations, bookmarks: target.bookmarks, viewport: target.viewport, selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [] }));
    hydrateNodeImages(nodes);
  },

  // 选中节点 / 装饰时新建组：按选中范围自动撑开，把内容完整包进组内
  frameSelection(): boolean {
    const nodeIDs = new Set(state.selectedNodeIDs);
    const decorationIDs = new Set(state.selectedDecorationIDs);
    const nodes = state.nodes.filter((node) => nodeIDs.has(node.id));
    const items = [
      ...nodes.map((node) => ({ ...node, ...graphNodeSize(node) })),
      ...state.decorations.filter((item) => decorationIDs.has(item.id)),
    ];
    if (items.length === 0) {
      return false;
    }
    const minX = Math.min(...items.map((item) => item.x));
    const minY = Math.min(...items.map((item) => item.y));
    const maxX = Math.max(...items.map((item) => item.x + item.width));
    const maxY = Math.max(...items.map((item) => item.y + item.height));
    const padding = 48;
    const frame: CanvasDecoration = {
      id: createNodeID(),
      kind: "frame",
      x: minX - padding,
      y: minY - padding - 16,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2 + 16,
      title: "组",
      text: "",
      color: "indigo",
      createdAt: Date.now(),
      zIndex: -10,
    };
    recordGraphHistory(currentSnapshot());
    setState((current) => ({
      ...current,
      ...reconcileFrameMembership(current.nodes, [...current.decorations, frame]),
      selectedDecorationIDs: [frame.id],
      selectedNodeIDs: [],
      canUndo: true,
      canRedo: false,
    }));
    return true;
  },

  addDecoration(kind: CanvasDecoration["kind"], point: { x: number; y: number }): void {
    const isNote = kind === "note";
    const item: CanvasDecoration = { id: createNodeID(), kind, x: point.x - (isNote ? 110 : 240), y: point.y - (isNote ? 70 : 160), width: isNote ? 220 : 480, height: isNote ? 140 : 320, title: isNote ? "注释" : "组", text: isNote ? "双击编辑文本" : "", color: isNote ? "amber" : "indigo", createdAt: Date.now(), zIndex: isNote ? 10 : -10 };
    setState((current) => ({ ...current, ...reconcileFrameMembership(current.nodes, [...current.decorations, item]), selectedDecorationIDs: [item.id], selectedNodeIDs: [] }));
  },

  updateDecoration(id: string, patch: Partial<CanvasDecoration>): void {
    setState((current) => {
      const decorations = current.decorations.map((item) => item.id === id ? { ...item, ...patch, id: item.id, kind: item.kind } : item);
      return { ...current, ...reconcileFrameMembership(current.nodes, decorations) };
    });
  },

  moveDecoration(id: string, x: number, y: number): void {
    setState((current) => {
      const decoration = current.decorations.find((item) => item.id === id);
      if (!decoration || decoration.locked) return current;
      const deltaX = x - decoration.x;
      const deltaY = y - decoration.y;
      const carriedIDs = decoration.kind === "frame"
        ? canvasElementIDsCarriedByFrame(id, [
          ...current.nodes.map((node) => ({ ...node, ...graphNodeSize(node) })),
          ...current.decorations.filter((item) => item.id !== id),
        ])
        : new Set<string>();
      const movedNodes = decoration.kind === "frame"
        ? current.nodes.map((node) => carriedIDs.has(node.id) ? { ...node, x: node.x + deltaX, y: node.y + deltaY } : node)
        : current.nodes;
      const movedDecorations = current.decorations.map((item) => item.id === id
        ? { ...item, x, y }
        : decoration.kind === "frame" && carriedIDs.has(item.id)
          ? { ...item, x: item.x + deltaX, y: item.y + deltaY }
          : item);
      return { ...current, nodes: movedNodes, decorations: movedDecorations };
    });
  },

  removeSelected(): void {
    const nodeIDs = new Set(state.selectedNodeIDs);
    const decorationIDs = new Set(state.selectedDecorationIDs);
    const edgeIDs = new Set(state.selectedEdgeIDs);
    setState((current) => {
      const removedNodeIDs = new Set(current.nodes.filter((item) => nodeIDs.has(item.id) && !item.locked).map((item) => item.id));
      const removedDecorationIDs = new Set(current.decorations.filter((item) => decorationIDs.has(item.id) && !item.locked).map((item) => item.id));
      if (removedNodeIDs.size === 0 && removedDecorationIDs.size === 0 && edgeIDs.size === 0) {
        return current;
      }
      for (const id of absorbedOutputIDs(current.nodes, removedNodeIDs)) {
        removedNodeIDs.add(id);
      }
      const nodes = current.nodes.filter((item) => !removedNodeIDs.has(item.id));
      const edges = current.edges.filter((edge) =>
        !edgeIDs.has(edge.id) && !removedNodeIDs.has(edge.fromNodeID) && !removedNodeIDs.has(edge.toNodeID));
      const decorations = current.decorations.filter((item) => !removedDecorationIDs.has(item.id));
      const reconciled = reconcileFrameMembership(nodes, decorations);
      return {
        ...current,
        ...reconciled,
        // Frame 成员（节点或装饰）被删除时边界自动回弹
        decorations: refitFrameDecorations(
          frameRefitElements(current.nodes, current.decorations),
          frameRefitElements(reconciled.nodes, reconciled.decorations),
          reconciled.decorations,
        ),
        edges,
        selectedNodeIDs: [],
        selectedDecorationIDs: [],
        selectedEdgeIDs: [],
      };
    });
  },

  toggleLockSelected(): void {
    const nodes = new Set(state.selectedNodeIDs); const decorations = new Set(state.selectedDecorationIDs);
    const selected = [...state.nodes.filter((item) => nodes.has(item.id)), ...state.decorations.filter((item) => decorations.has(item.id))];
    const lock = selected.some((item) => !item.locked);
    setState((current) => ({ ...current, nodes: current.nodes.map((item) => nodes.has(item.id) ? { ...item, locked: lock } : item), decorations: current.decorations.map((item) => decorations.has(item.id) ? { ...item, locked: lock } : item) }));
  },

  addBookmark(name?: string): void {
    const item: CanvasBookmark = { id: createNodeID(), name: name?.trim() || `View ${state.bookmarks.length + 1}`, viewport: state.viewport, createdAt: Date.now() };
    setState((current) => ({ ...current, bookmarks: [...current.bookmarks, item] }));
  },
  goToBookmark(id: string): void { const item = state.bookmarks.find((bookmark) => bookmark.id === id); if (item) canvasStore.setViewport(item.viewport); },
  removeBookmark(id: string): void { setState((current) => ({ ...current, bookmarks: current.bookmarks.filter((item) => item.id !== id) })); },

  createVersion(name?: string): void {
    const versions = [{ id: createNodeID(), name: name?.trim() || `Snapshot ${state.versions.length + 1}`, createdAt: Date.now(), activeCanvasID: state.activeCanvasID, canvases: allPages(state) }, ...state.versions].slice(0, 20);
    setState((current) => ({ ...current, versions }));
  },
  restoreVersion(id: string): void {
    const snapshot = state.versions.find((item) => item.id === id);
    if (!snapshot) return;
    const target = snapshot.canvases.find((item) => item.id === snapshot.activeCanvasID) ?? snapshot.canvases[0];
    const nodes = restoreGraphNodes(target.graphNodes ?? []);
    const edges = restoreEdges(target.edges ?? [], nodes);
    setState((current) => ({ ...current, canvases: snapshot.canvases, activeCanvasID: target.id, nodes, edges, decorations: target.decorations, bookmarks: target.bookmarks, viewport: target.viewport, selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [] }));
    hydrateNodeImages(nodes);
  },

  exportProject(): string { return JSON.stringify(getPersistedState(), null, 2); },
  importProject(persisted: PersistedCanvasState): void {
    restoreFromPersisted(persisted);
    lastPersistedRaw = "";
    schedulePersist();
  },

  // 记录当前选中模型：同时保存名称与身份键（键用于区分接口重名模型）
  setSelectedModel(model: CanvasModelOption | null, mediaType: CanvasMediaType = "image"): void {
    if (!model) {
      return;
    }
    const key = canvasModelKey(model);
    setState((current) => {
      if (mediaType === "video") {
        const unchanged = current.restoredVideoModelKey === key && current.restoredVideoModelName === model.platformModelName;
        return unchanged ? current : { ...current, restoredVideoModelKey: key, restoredVideoModelName: model.platformModelName };
      }
      const unchanged = current.restoredModelKey === key && current.restoredModelName === model.platformModelName;
      return unchanged ? current : { ...current, restoredModelKey: key, restoredModelName: model.platformModelName };
    });
  },

  // -------------------------------------------------------------------------
  // 图节点 CRUD
  // -------------------------------------------------------------------------
  addGraphNode(kind: GraphNodeKind, point?: { x: number; y: number }, mediaType: CanvasNodeMediaHint = "image"): string {
    const nodeID = createNodeID();
    const position = nextNodePosition(kind, point);
    const base = { id: nodeID, kind, x: position.x, y: position.y, createdAt: Date.now() };
    let node: GraphNode;
    if (kind === "prompt") {
      node = { ...base, kind: "prompt", text: "" } satisfies PromptGraphNode;
    } else if (kind === "image") {
      node = { ...base, kind: "image", reference: null } satisfies ImageGraphNode;
    } else if (kind === "generate") {
      const nodeMediaType: CanvasMediaType = mediaType === "video" ? "video" : "image";
      const selectedKey = nodeMediaType === "video" ? state.restoredVideoModelKey : state.restoredModelKey;
      const selectedScope = parseCanvasModelKey(selectedKey);
      node = {
        ...base, kind: "generate", mediaType: nodeMediaType,
        model: nodeMediaType === "video" ? state.restoredVideoModelName : state.restoredModelName,
        modelScope: selectedScope.scope,
        userModelID: selectedScope.userModelID,
        options: {}, resultCount: 1,
        prompt: "", promptAssets: [],
        operation: "generate", maskReference: null, runStatus: "idle",
      } satisfies GenerateGraphNode;
    } else if (kind === "media") {
      node = { ...base, kind: "media", mediaKind: mediaType === "audio" ? "audio" : "video", reference: null } satisfies MediaGraphNode;
    } else if (kind === "timeline") {
      node = { ...base, kind: "timeline", segments: [] } satisfies TimelineGraphNode;
    } else {
      node = { ...base, kind: "output", mediaType: mediaType === "video" ? "video" : undefined, status: "empty" } satisfies OutputGraphNode;
    }
    recordGraphHistory(currentSnapshot());
    setState((current) => {
      const reconciled = reconcileFrameMembership([...current.nodes, node], current.decorations);
      return {
        ...current,
        ...reconciled,
        // 新节点被 Frame 承载时，Frame 自动扩展以容纳新内容
        decorations: refitFrameDecorations(
          frameRefitElements(current.nodes, current.decorations),
          frameRefitElements(reconciled.nodes, reconciled.decorations),
          reconciled.decorations,
        ),
        selectedNodeIDs: [nodeID],
        selectedDecorationIDs: [],
        selectedEdgeIDs: [],
        canUndo: true,
        canRedo: false,
      };
    });
    return nodeID;
  },

  updateGraphNode(nodeID: string, patch: GraphNodeUpdate): void {
    // 时间线的片段 / 轨道属于结构编辑：写入撤销栈，支持误操作回退
    if ("segments" in patch || "tracks" in patch) {
      recordGraphHistory(currentSnapshot());
    }
    updateNode(nodeID, (node) => ({ ...node, ...patch, id: node.id, kind: node.kind }) as GraphNode);
  },

  // 参考素材节点预览缺失时按 fileID 拉取（刷新恢复、跨节点拖入后由视图触发）
  ensureNodeImagePreview(nodeID: string): void {
    const node = state.nodes.find((item) => item.id === nodeID);
    if (node && isReferencePreviewNode(node) && node.reference && !node.previewURL && !node.previewLoading) {
      void loadImageNodePreview(nodeID, node.reference.fileID);
    }
  },

  // 将节点纳入 Frame 承载：写入归属并扩展 Frame 以容纳该节点
  adoptNodeIntoFrame(nodeID: string, frameID: string | null): void {
    setState((current) => {
      const node = current.nodes.find((item) => item.id === nodeID);
      if (!node) {
        return current;
      }
      const nodes = current.nodes.map((item) => (item.id === nodeID ? { ...item, frameID } : item));
      let decorations = current.decorations;
      if (frameID) {
        const frame = decorations.find((item) =>
          item.id === frameID && item.kind === "frame" && !item.locked && !item.collapsed);
        if (frame) {
          const size = graphNodeSize(node);
          decorations = decorations.map((item) =>
            item.id === frameID
              ? { ...item, ...frameUnionBounds(item, [{ id: nodeID, x: node.x, y: node.y, width: size.width, height: size.height }]) }
              : item);
        }
      }
      const reconciled = reconcileFrameMembership(nodes, decorations);
      return { ...current, nodes: reconciled.nodes, decorations: reconciled.decorations };
    });
  },

  beginNodeMove(): void {
    if (!nodeMoveSnapshot) {
      nodeMoveSnapshot = cloneSnapshot(currentSnapshot());
    }
  },

  moveNodes(positionList: { nodeID: string; x: number; y: number }[]): void {
    const positions = new Map(positionList.map((item) => [item.nodeID, item]));
    setState((current) => {
      const nodes = current.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, x: position.x, y: position.y } : node;
      });
      return { ...current, ...reconcileFrameMembership(nodes, current.decorations) };
    });
  },

  endNodeMove(): void {
    const snapshot = nodeMoveSnapshot;
    nodeMoveSnapshot = null;
    if (!snapshot || !snapshot.nodes.some((node, index) => {
      const current = state.nodes[index];
      return !current || current.id !== node.id || current.x !== node.x || current.y !== node.y;
    })) {
      return;
    }
    recordGraphHistory(snapshot);
    // 拖拽把节点带出/带入 Frame 时边界自动回弹或扩展（橡皮筋预览已在松手时提交）
    setState((current) => ({
      ...current,
      decorations: refitFrameDecorations(
        frameRefitElements(snapshot.nodes, current.decorations),
        frameRefitElements(current.nodes, current.decorations),
        current.decorations,
      ),
    }));
    updateHistoryAvailability();
    emit();
  },

  removeNodes(nodeIDs: string[]): void {
    const removed = new Set(state.nodes
      .filter((node) => nodeIDs.includes(node.id) && !node.locked)
      .map((node) => node.id));
    if (removed.size === 0) {
      return;
    }
    // 输出子节点已合并进生成节点卡片：生成节点被删除时一并删除，避免留下不可见残留
    for (const id of absorbedOutputIDs(state.nodes, removed)) {
      removed.add(id);
    }
    for (const nodeID of removed) {
      const controller = abortControllers.get(nodeID);
      if (controller) {
        controller.abort();
        abortControllers.delete(nodeID);
      }
    }
    recordGraphHistory(currentSnapshot());
    setState((current) => {
      const nodes = current.nodes.filter((node) => !removed.has(node.id));
      const edges = current.edges.filter((edge) => !removed.has(edge.fromNodeID) && !removed.has(edge.toNodeID));
      return {
        ...current,
        nodes,
        edges,
        // Frame 成员被删除时边界自动回弹到剩余内容
        decorations: refitFrameDecorations(
          frameRefitElements(current.nodes, current.decorations),
          frameRefitElements(nodes, current.decorations),
          current.decorations,
        ),
        selectedNodeIDs: current.selectedNodeIDs.filter((id) => !removed.has(id)),
        canUndo: true,
        canRedo: false,
      };
    });
  },

  removeNode(nodeID: string): void {
    canvasStore.removeNodes([nodeID]);
  },

  // 复制副本：保留模型、参数、提示词与素材引用；运行态与任务绑定一律复位，
  // 生成节点同时复制其输出子节点，副本整体偏移到右下方便于区分。
  duplicateNodes(nodeIDs: string[]): void {
    const sources = state.nodes.filter((node) => nodeIDs.includes(node.id) && !node.locked);
    if (sources.length === 0) {
      return;
    }
    const sourceIDs = new Set(sources.map((node) => node.id));
    const outputs = state.nodes.filter((node): node is OutputGraphNode =>
      node.kind === "output" && Boolean(node.sourceGenerateID) && sourceIDs.has(node.sourceGenerateID as string));
    recordGraphHistory(currentSnapshot());
    const now = Date.now();
    const idMap = new Map<string, string>();
    for (const node of [...sources, ...outputs]) {
      idMap.set(node.id, createNodeID());
    }
    const clones: GraphNode[] = [...sources, ...outputs].map((node): GraphNode => {
      const nextID = idMap.get(node.id) as string;
      if (node.kind === "generate") {
        return {
          ...node, id: nextID, x: node.x + 48, y: node.y + 48, createdAt: now, locked: false,
          runStatus: "idle", statusLabel: undefined, previewURL: undefined, progress: undefined,
          errorMessage: undefined, errorDetail: undefined, conversationID: undefined, runID: undefined,
        };
      }
      if (node.kind === "output") {
        return {
          ...node, id: nextID, x: node.x + 48, y: node.y + 48, createdAt: now, locked: false,
          sourceGenerateID: node.sourceGenerateID ? idMap.get(node.sourceGenerateID) ?? node.sourceGenerateID : null,
          conversationID: undefined, runID: undefined, pendingRetry: undefined, retrySaving: undefined,
          statusLabel: undefined, progress: undefined, previewURL: undefined,
        };
      }
      return { ...node, id: nextID, x: node.x + 48, y: node.y + 48, createdAt: now, locked: false };
    });
    setState((current) => ({
      ...current,
      ...reconcileFrameMembership([...current.nodes, ...clones], current.decorations),
      selectedNodeIDs: clones.filter((node) => node.kind !== "output").map((node) => node.id),
      selectedDecorationIDs: [],
      selectedEdgeIDs: [],
      canUndo: true,
      canRedo: false,
    }));
  },

  // 复制节点到跨项目剪贴板：内存保存运行时数据，localStorage 兜底跨页面/刷新
  copySelectedNodes(nodeIDs: string[]): number {
    const sources = state.nodes.filter((node) => nodeIDs.includes(node.id) && !node.locked);
    if (sources.length === 0) {
      return 0;
    }
    const ids = new Set(sources.map((node) => node.id));
    const outputs = state.nodes.filter((node): node is OutputGraphNode =>
      node.kind === "output" && Boolean(node.sourceGenerateID) && ids.has(node.sourceGenerateID as string));
    const all = [...sources, ...outputs];
    const allIDs = new Set(all.map((node) => node.id));
    const edges = state.edges.filter((edge) => allIDs.has(edge.fromNodeID) && allIDs.has(edge.toNodeID));
    nodeClipboardMemory = {
      nodes: all.map((node) => ({ ...node })),
      edges: edges.map((edge) => ({ ...edge })),
    };
    try {
      window.localStorage.setItem(NODE_CLIPBOARD_KEY, JSON.stringify({
        nodes: toPersistedGraphNodes(all),
        edges: toPersistedEdges(edges),
        createdAt: Date.now(),
      }));
    } catch {
      // 存储不可用时仅保留内存剪贴板
    }
    return sources.length;
  },

  hasCopiedNodes(): boolean {
    if (nodeClipboardMemory) {
      return true;
    }
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return Boolean(window.localStorage.getItem(NODE_CLIPBOARD_KEY));
    } catch {
      return false;
    }
  },

  // 粘贴节点：重新分配 ID、重映射内部连线，可粘贴到其他画布项目
  pasteCopiedNodes(point?: { x: number; y: number }): number {
    const payload = (() => {
      if (nodeClipboardMemory) {
        return nodeClipboardMemory;
      }
      if (typeof window === "undefined") {
        return null;
      }
      try {
        const raw = window.localStorage.getItem(NODE_CLIPBOARD_KEY);
        if (!raw) {
          return null;
        }
        const parsed = JSON.parse(raw) as { nodes?: unknown; edges?: unknown };
        const persistedNodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
          .flatMap((item) => {
            const node = graphNode(item);
            return node ? [node] : [];
          });
        if (persistedNodes.length === 0) {
          return null;
        }
        const restoredNodes = restoreGraphNodes(persistedNodes);
        const validIDs = new Set(restoredNodes.map((node) => node.id));
        const persistedEdges = (Array.isArray(parsed.edges) ? parsed.edges : [])
          .flatMap((item) => {
            const edge = graphEdge(item, validIDs);
            return edge ? [edge] : [];
          });
        return { nodes: restoredNodes, edges: restoreEdges(persistedEdges, restoredNodes) };
      } catch {
        return null;
      }
    })();
    if (!payload || payload.nodes.length === 0) {
      return 0;
    }
    const bounds = payload.nodes.reduce((box, node) => ({
      left: Math.min(box.left, node.x),
      top: Math.min(box.top, node.y),
      right: Math.max(box.right, node.x + graphNodeSize(node).width),
      bottom: Math.max(box.bottom, node.y + graphNodeSize(node).height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const originX = point?.x ?? bounds.left + 48;
    const originY = point?.y ?? bounds.top + 48;
    const offsetX = originX - bounds.left;
    const offsetY = originY - bounds.top;
    const idMap = new Map<string, string>();
    for (const node of payload.nodes) {
      idMap.set(node.id, createNodeID());
    }
    const now = Date.now();
    const clones = payload.nodes.map((node): GraphNode => {
      const nextID = idMap.get(node.id) as string;
      const place = {
        id: nextID,
        x: Math.round(node.x + offsetX),
        y: Math.round(node.y + offsetY),
        createdAt: now,
        locked: false,
        frameID: null,
      };
      if (node.kind === "generate") {
        return {
          ...node, ...place,
          runStatus: "idle", statusLabel: undefined, previewURL: undefined, progress: undefined,
          errorMessage: undefined, errorDetail: undefined, conversationID: undefined, runID: undefined,
        };
      }
      if (node.kind === "output") {
        return {
          ...node, ...place,
          sourceGenerateID: node.sourceGenerateID ? idMap.get(node.sourceGenerateID) ?? null : null,
          status: node.status === "done" && node.fileID ? "done" : "empty",
          conversationID: undefined, runID: undefined, pendingRetry: undefined, retrySaving: undefined,
          statusLabel: undefined, progress: undefined, previewURL: undefined,
        };
      }
      if (node.kind === "timeline") {
        // 片段来源必须在本次复制范围内，否则无法在新项目里解析
        const segments = node.segments.flatMap((segment) => {
          const nextSourceID = idMap.get(segment.sourceNodeID);
          return nextSourceID ? [{ ...segment, sourceNodeID: nextSourceID }] : [];
        });
        return { ...node, ...place, segments };
      }
      return { ...node, ...place };
    });
    const cloneIDs = new Set(clones.map((node) => node.id));
    const cloneEdges = payload.edges.flatMap((edge) => {
      const fromNodeID = idMap.get(edge.fromNodeID);
      const toNodeID = idMap.get(edge.toNodeID);
      return fromNodeID && toNodeID && cloneIDs.has(fromNodeID) && cloneIDs.has(toNodeID)
        ? [{ ...edge, id: createNodeID(), fromNodeID, toNodeID, createdAt: now }]
        : [];
    });
    recordGraphHistory(currentSnapshot());
    setState((current) => ({
      ...current,
      ...reconcileFrameMembership([...current.nodes, ...clones], current.decorations),
      edges: [...current.edges, ...cloneEdges],
      selectedNodeIDs: clones.filter((node) => node.kind !== "output").map((node) => node.id),
      selectedDecorationIDs: [],
      selectedEdgeIDs: [],
      canUndo: true,
      canRedo: false,
    }));
    // 参考素材节点在新项目里没有本地预览地址，按 fileID 重新拉取
    for (const node of clones) {
      if ((node.kind === "image" || node.kind === "media") && node.reference && !node.previewURL) {
        void loadImageNodePreview(node.id, node.reference.fileID);
      }
    }
    return clones.filter((node) => node.kind !== "output").length;
  },

  connectGraphNodes(attempt: GraphConnectionAttempt): boolean {
    const decision = canConnectGraphNodes(state.nodes, state.edges, attempt);
    if (!decision.ok) {
      return false;
    }
    recordGraphHistory(currentSnapshot());
    setState((current) => {
      const source = current.nodes.find((node) => node.id === attempt.fromNodeID);
      const target = current.nodes.find((node) => node.id === attempt.toNodeID);
      // 文本节点连到生成节点的文本端口：目标提示词为空时自动填充文本内容
      const filledNodes = attempt.toPort === "prompt"
        && source?.kind === "prompt"
        && target?.kind === "generate"
        && !(target.prompt ?? "").trim()
        && source.text.trim()
        ? current.nodes.map((node) => node.id === target.id ? { ...node, prompt: source.text } : node)
        : current.nodes;
      // 时间线节点：每条素材入边对应一个片段，按端口落到的轨道追加到末尾
      const segmentTrack = attempt.trackID
        ?? (attempt.toPort === "audio" ? "audio" : "video");
      const nodes = target?.kind === "timeline" && (attempt.toPort === "video" || attempt.toPort === "audio") && source
        ? filledNodes.map((node) => node.id === target.id && node.kind === "timeline"
          ? {
            ...node,
            segments: [
              ...node.segments,
              { id: createNodeID(), sourceNodeID: source.id, track: segmentTrack, start: 0, end: 0 },
            ],
          }
          : node)
        : filledNodes;
      return {
        ...current,
        nodes,
        edges: [...current.edges, { id: createNodeID(), fromNodeID: attempt.fromNodeID, toNodeID: attempt.toNodeID, toPort: attempt.toPort, createdAt: Date.now() }],
        selectedEdgeIDs: [],
        canUndo: true,
        canRedo: false,
      };
    });
    return true;
  },

  // 连线拖到空白处：按起拖端口自动创建匹配的节点并立即连线，免去「先建节点再连线」两步
  connectToNewNode(
    drag: {
      fromNodeID: string;
      fromPort: GraphPortID;
      fromDirection: "in" | "out";
      fromKind: GraphNodeKind;
      fromMediaKind?: CanvasMediaKind;
      fromMediaType?: CanvasMediaType;
    },
    point: { x: number; y: number },
    // 用户在连线类型菜单中选择的创建目标；缺省按起拖类型自动推断
    option?: CanvasAutoConnectOption,
  ): boolean {
    const plan = option ?? resolveAutoConnectPlan(drag);
    if (!plan) {
      return false;
    }
    const nodeID = canvasStore.addGraphNode(plan.kind, point, plan.mediaType);
    return canvasStore.connectGraphNodes(
      plan.reverse
        ? { fromNodeID: nodeID, fromPort: "out", toNodeID: drag.fromNodeID, toPort: plan.toPort }
        : { fromNodeID: drag.fromNodeID, fromPort: "out", toNodeID: nodeID, toPort: plan.toPort },
    );
  },

  removeEdge(edgeID: string): void {
    const target = state.edges.find((edge) => edge.id === edgeID);
    if (!target) {
      return;
    }
    recordGraphHistory(currentSnapshot());
    const edgePort = target.toPort;
    setState((current) => ({
      ...current,
      // 时间线节点的片段由入边生成：删除连线时同步移除对应轨道类型的片段（含自定义轨道）
      nodes: current.nodes.map((node) => {
        if (node.kind !== "timeline" || node.id !== target.toNodeID || (edgePort !== "video" && edgePort !== "audio")) {
          return node;
        }
        const targetKind = edgePort === "audio" ? "audio" : "video";
        return {
          ...node,
          segments: node.segments.filter((segment) => {
            const trackID = segment.track ?? "video";
            const kind = node.tracks?.find((track) => track.id === trackID)?.kind
              ?? (trackID.startsWith("audio") ? "audio" : "video");
            return !(segment.sourceNodeID === target.fromNodeID && kind === targetKind);
          }),
        };
      }),
      edges: current.edges.filter((edge) => edge.id !== edgeID),
      selectedEdgeIDs: current.selectedEdgeIDs.filter((id) => id !== edgeID),
      canUndo: true,
      canRedo: false,
    }));
  },

  undo(): void {
    const previous = undoStack.pop();
    if (!previous) {
      return;
    }
    abortMissingNodes(previous.nodes);
    redoStack.push(cloneSnapshot(currentSnapshot()));
    setState((current) => {
      const restored = cloneSnapshot(previous);
      return {
        ...current,
        nodes: restored.nodes,
        edges: previous.edges,
        // 撤销导致的成员增减同样触发 Frame 回弹/扩展
        decorations: refitFrameDecorations(
          frameRefitElements(current.nodes, current.decorations),
          frameRefitElements(restored.nodes, current.decorations),
          current.decorations,
        ),
        selectedNodeIDs: [],
        selectedEdgeIDs: [],
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      };
    });
    hydrateNodeImages(previous.nodes);
  },

  redo(): void {
    const next = redoStack.pop();
    if (!next) {
      return;
    }
    undoStack.push(cloneSnapshot(currentSnapshot()));
    setState((current) => ({
      ...current,
      nodes: next.nodes,
      edges: next.edges,
      decorations: refitFrameDecorations(
        frameRefitElements(current.nodes, current.decorations),
        frameRefitElements(next.nodes, current.decorations),
        current.decorations,
      ),
      selectedNodeIDs: [],
      selectedEdgeIDs: [],
      canUndo: true,
      canRedo: redoStack.length > 0,
    }));
    hydrateNodeImages(next.nodes);
  },

  cancelNode(nodeID: string): void {
    const controller = abortControllers.get(nodeID);
    if (controller) {
      controller.abort();
      return;
    }
    // 启动窗口期（尚未注册 controller）的取消：记录后由 runGenerateNode 在启动流前落地
    startAborts.add(nodeID);
  },

  clearCanvas(): void {
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    abortControllers.clear();
    startAborts.clear();
    for (const objectURL of objectURLCache.values()) {
      URL.revokeObjectURL(objectURL);
    }
    objectURLCache.clear();
    nodeSpawnCounter = 0;
    nodeMoveSnapshot = null;
    if (state.nodes.length > 0 || state.edges.length > 0) {
      recordGraphHistory(currentSnapshot());
    }
    clearCanvasState();
    lastPersistedRaw = "";
    setState((current) => ({
      ...current,
      nodes: [],
      edges: [],
      decorations: [],
      bookmarks: [],
      selectedNodeIDs: [],
      selectedDecorationIDs: [],
      selectedEdgeIDs: [],
      canUndo: undoStack.length > 0,
      canRedo: false,
    }));
  },

  // -------------------------------------------------------------------------
  // 图执行引擎：生成节点汇聚上游提示词与参考图并流式生成，结果写入输出节点
  // -------------------------------------------------------------------------
  async runGenerateNode(generateNodeID: string, overrides?: { prompt?: string }): Promise<void> {
    const generateNode = state.nodes.find((node) => node.id === generateNodeID);
    if (!generateNode || generateNode.kind !== "generate" || !labels) {
      return;
    }
    // 同一生成节点已有运行中的输出任务时忽略重复触发：避免重复计费与并发冲突。
    // 取消或完成后再运行由输出节点状态自然放行。
    const hasRunningOutput = state.nodes.some(
      (item) => item.kind === "output" && item.sourceGenerateID === generateNodeID && item.status === "running",
    );
    if (hasRunningOutput) {
      return;
    }
    startAborts.delete(generateNodeID);
    const mediaType = generateNode.mediaType ?? "image";
    const inputs = gatherGraphGenerateInputs(generateNodeID, state.nodes, state.edges);
    // 提示词优先取节点内绑定内容；对话模式继承输入优先于节点文本；旧提示词节点作为回退。
    // 素材引用按类型序号（图1 / 视频1）发送：模型看不到文件名，只能靠序号定位素材。
    const boundPrompt = overrides?.prompt?.trim() || generateNode.prompt?.trim() || inputs.prompt;
    const prompt = promptForModelWithAssets(boundPrompt, (fileID) => {
      for (const node of state.nodes) {
        if ((node.kind === "image" || node.kind === "media") && node.reference?.fileID === fileID) {
          return canvasAssetKind(node.reference.mimeType, node.reference.fileName);
        }
        if (node.kind === "output" && node.fileID === fileID) {
          return canvasAssetKind(node.mimeType, node.fileName);
        }
      }
      return null;
    });
    const model = canvasStore.resolveModel(generateNode.model, mediaType, generateNode.modelScope, generateNode.userModelID);
    if (!model) {
      const message = mediaType === "video" ? (labels.noVideoModels ?? labels.noImageModels) : labels.noImageModels;
      markGenerateNodeError(generateNodeID, message);
      toast.error(message);
      return;
    }
    if (!graphGenerateHasInputs({ ...inputs, prompt }) || (mediaType === "video" && !prompt.trim())) {
      // 视频生成的 prompt 为上游必填项，单独提示
      const message = mediaType === "video" && !prompt.trim()
        ? labels.videoPromptRequired
        : labels.missingPromptInput;
      markGenerateNodeError(generateNodeID, message);
      return;
    }
    const promptAssets = promptAssetReferences(generateNode, state.nodes, boundPrompt);
    const references = dedupeReferences([...inputs.references, ...promptAssets.images]);
    // 视频路线把全部参考素材交给后端按 MIME 分类；图像路线只用参考图决定编辑/生成路由
    const requestReferences = mediaType === "video"
      ? dedupeReferences([
        ...references,
        ...inputs.videoReferences,
        ...inputs.audioReferences,
        ...promptAssets.videos,
        ...promptAssets.audios,
      ])
      : references;
    const decision = resolveCanvasMediaRoute(model, mediaType, references.length);
    if (decision.blockedReason) {
      const message = decision.blockedReason === "edit_reference_required"
        ? labels.editReferenceRequired
        : decision.blockedReason === "edit_unsupported"
          ? labels.editUnsupported
          : decision.blockedReason === "video_unsupported"
            ? labels.videoUnsupported
            : labels.imageUnsupported;
      markGenerateNodeError(generateNodeID, message);
      toast.error(message);
      return;
    }

    const token = await resolveAccessToken();
    if (!token) {
      markGenerateNodeError(generateNodeID, labels.needLogin);
      toast.error(labels.needLogin);
      return;
    }

    let conversationID: string;
    try {
      conversationID = await createTaskConversation(token);
    } catch {
      markGenerateNodeError(generateNodeID, labels.conversationCreateFailed);
      return;
    }

    const operation: CanvasOperation = references.length > 0 && generateNode.operation === "generate"
      ? "edit"
      : generateNode.operation;
    const startedAt = Date.now();
    // 每次运行生成唯一 runID：后端 conversation_runs 以 run_id 做唯一约束，
    // 复用确定性 ID 会让同节点的第二次运行撞 409 already_exists。
    // 恢复引擎读取节点上持久化的 runID，不依赖 ID 的确定性。
    const runID = `canvas-${generateNodeID}-${startedAt.toString(36)}`;
    const resultCount = mediaType === "video" ? 1 : generateNode.resultCount;

    // 任务创建即转交输出节点：先分配/派生输出节点并进入 running 态（等待/进度/取消都在输出节点），
    // 生成节点只同步模型配置；任务引用不写生成节点（支持并发多次生成，恢复引擎按输出节点分组接管）
    const outputNodeIDs = allocateOutputTargets(generateNode, resultCount);
    updateNode(generateNodeID, (node) => {
      if (node.kind !== "generate") {
        return node;
      }
      return {
        ...node,
        model: model.platformModelName,
        mediaType,
        operation,
        errorMessage: undefined,
        errorDetail: undefined,
        progress: undefined,
      };
    });
    // 会话与运行引用写入输出节点：恢复引擎按此续传 / 兜底
    for (const nodeID of outputNodeIDs) {
      updateNode(nodeID, (node) =>
        node.kind === "output" && node.status === "running"
          ? { ...node, conversationID, runID, prompt, model: model.platformModelName }
          : node,
      );
    }

    // 准备期（取 token/创建会话）收到的取消（输出节点取消按钮按 runID 登记）：不启动生成流
    if (startAborts.has(runID)) {
      startAborts.delete(runID);
      markOutputTargetsError(outputNodeIDs, labels.canceled ?? "");
      void deleteConversation(token, conversationID).catch(() => {});
      return;
    }

    await canvasStore.runGeneration({
      generateNodeID,
      outputNodeIDs,
      prompt,
      model,
      options: generateNode.options,
      resultCount,
      references: requestReferences,
      maskReference: generateNode.maskReference ?? null,
      mediaType,
      // 图像生成 / 编辑协议固定非流式；只有视频生成沿用节点的流式开关
      stream: mediaType === "video" ? generateNode.stream !== false : false,
      route: decision.route,
      conversationID,
      runID,
      token,
      startedAt,
    });
  },

  async runGeneration({
    generateNodeID,
    outputNodeIDs,
    prompt,
    model,
    options,
    resultCount,
    references,
    maskReference,
    mediaType,
    stream,
    route,
    conversationID,
    runID,
    token,
    startedAt,
  }: {
    generateNodeID: string;
    // 任务转交的目标输出节点：等待/进度/流式响应与错误都落在这些节点上
    outputNodeIDs: string[];
    prompt: string;
    model: CanvasModelOption;
    options: ConversationOptions;
    resultCount: number;
    references: CanvasNodeReference[];
    maskReference: CanvasNodeReference | null;
    mediaType: CanvasMediaType;
    // 本次生成是否使用流式上游请求
    stream: boolean;
    route: "image_generation" | "image_edit" | "chat" | "video_generation";
    conversationID: string;
    runID: string;
    token: string;
    startedAt: number;
  }): Promise<void> {
    const controller = new AbortController();
    // 运行控制器按 runID 登记：同一生成节点可并发多次生成，互不干扰
    abortControllers.set(runID, controller);
    setGeneratingDelta(1);

    const mergedOptions = mergeCanvasOptions(model.defaultOptions ?? {}, options);
    let assistantText = "";
    // 保存待重试产物收集：上游生成已成功但产物保存瞬时失败，落位为输出节点的重试引用
    const pendingArtifacts: OutputPendingRetry[] = [];
    const streamOptions = buildStreamOptions(outputNodeIDs, mediaType, controller.signal, {
      onDelta: (delta) => {
        assistantText += delta;
      },
      onMediaArtifactPending: (event) => {
        const eventMediaType = event.media_type === "video" ? "video" : "image";
        for (const index of event.indexes ?? []) {
          pendingArtifacts.push({ mediaType: eventMediaType, runID: event.run_id, index });
        }
      },
    });

    try {
      // 启动一次生成流：媒体任务可能长时间等待，断流后凭同一 run 引用续传
      const startStream = () => (route === "chat"
        ? streamMessage(
          token,
          conversationID,
          {
            content: isChatRouteImageModel(model)
              ? `${prompt}${chatImagePromptSuffix(mergedOptions)}`
              : prompt,
            contentType: references.length > 0 ? "mixed" : "text",
            stream,
            knowledgeBaseIDs: [],
            model: model.platformModelName,
            options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
            clientRunID: runID,
            fileIDs: references.length > 0 ? references.map((item) => item.fileID) : undefined,
          } satisfies SendMessageRequest,
          streamOptions,
        )
        : route === "video_generation"
          ? streamVideoGeneration(
            token,
            conversationID,
            {
              prompt,
              model: model.platformModelName,
              options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
              clientRunID: runID,
              fileIDs: references.length > 0 ? references.map((item) => item.fileID) : undefined,
            } satisfies MediaVideoRequest,
            streamOptions,
          )
          : (() => {
            const payload: MediaImageRequest = {
              prompt,
              model: model.platformModelName,
              options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
              // 图像生成 / 编辑协议固定非流式：显式关闭流式，上游不会收到 stream=true
              stream: false,
              clientRunID: runID,
              fileIDs: references.length > 0 ? references.map((item) => item.fileID) : undefined,
              maskFileID: maskReference?.fileID,
            };
            return route === "image_edit"
              ? streamImageEdit(token, conversationID, payload, streamOptions)
              : streamImageGeneration(token, conversationID, payload, streamOptions);
          })());

      // 网络中断只对媒体流自动补救一次：用同一 run 引用续传，仍拿不到结果就按原错误路径落错误态
      const completed = await (async () => {
        try {
          return await startStream();
        } catch (streamError) {
          if (route === "chat" || controller.signal.aborted || !(streamError instanceof ApiNetworkError)) {
            throw streamError;
          }
          const resumed = await resumeMessageGenerationStream(token, runID, { ...streamOptions });
          if (!resumed) {
            throw streamError;
          }
          return resumed;
        }
      })();

      await canvasStore.completeGeneration({
        generateNodeID,
        outputNodeIDs,
        prompt,
        modelName: model.platformModelName,
        resultCount,
        mediaType,
        completed,
        assistantText,
        startedAt,
        pendingArtifacts,
      });
    } catch (error) {
      // 运行失败：错误落在任务绑定的输出节点上（保留 runID 供重查），生成节点仅清除任务引用
      if (controller.signal.aborted) {
        markOutputTargetsError(outputNodeIDs, labels?.canceled ?? "");
      } else if (error instanceof ApiError && error.errorCode === "content_moderation.blocked") {
        markOutputTargetsError(outputNodeIDs, labels?.moderationBlocked ?? "", errorDetailFromApiError(error));
      } else if (error instanceof ApiError) {
        markOutputTargetsError(
          outputNodeIDs,
          resolveLocalizedErrorMessageWithoutReference(error, labels?.generateFailed ?? ""),
          errorDetailFromApiError(error) ?? (assistantText.trim() || undefined),
        );
      } else {
        const message = error instanceof Error && error.message ? error.message : labels?.generateFailed || "";
        markOutputTargetsError(outputNodeIDs, message, assistantText.trim() || undefined);
      }
    } finally {
      abortControllers.delete(runID);
      setGeneratingDelta(-1);
      // 画布任务使用一次性会话；软删除会话但保留文件，避免左侧记录与后续上下文串联。
      try {
        await deleteConversation(token, conversationID);
      } catch {
        // 会话清理失败不影响已经完成的画布节点。
      }
    }
  },

  // 生成完成的收尾：解析结果附件、写入输出节点并复位任务绑定。
  // 正常运行与刷新恢复共用，保证两条路径的产物落位一致。
  // outputNodeIDs 为任务创建时预分配的目标输出节点（运行状态所在）；缺省时（旧版恢复链路）
  // 沿用按连线复用/派生输出节点的落位规则。
  // pendingArtifacts 为保存待重试产物：生成已成功，落位为输出节点的重试引用。
  async completeGeneration({
    generateNodeID,
    outputNodeIDs,
    prompt,
    modelName,
    resultCount,
    mediaType,
    completed,
    assistantText = "",
    startedAt,
    pendingArtifacts = [],
  }: {
    generateNodeID: string;
    outputNodeIDs?: string[];
    prompt: string;
    modelName: string;
    resultCount: number;
    mediaType: CanvasMediaType;
    completed: { assistantMessage: MessageDTO };
    assistantText?: string;
    startedAt?: number;
    pendingArtifacts?: OutputPendingRetry[];
  }): Promise<void> {
    // 收尾期输出节点进入保存态（优先落位到任务绑定的输出节点上）
    const savingTargets = outputNodeIDs ?? [];
    for (const nodeID of savingTargets) {
      updateNode(nodeID, (node) =>
        node.kind === "output" && node.status === "running"
          ? { ...node, statusLabel: labels?.nodeSavingLocal ?? node.statusLabel }
          : node,
      );
    }

    const attachments = parseAttachments(completed.assistantMessage.attachments);
    const mediaAttachments = mediaType === "video"
      ? attachments.filter((item) => item.mimeType.startsWith("video/"))
      : attachments.filter((item) => item.kind === "image");
    const rawResponse = completed.assistantMessage.content?.trim() || assistantText.trim();

    // 部分图像上游会把图片放进 Markdown 文本，而不是 attachments。
    // 提取 URL / Data URL / Base64 后上传到文件服务，使输出节点仍可持久化、下载和继续编辑。
    if (mediaType === "image" && mediaAttachments.length === 0 && rawResponse) {
      const imageSource = resolveCanvasChatImageSource(rawResponse);
      if (imageSource) {
        const token = await resolveAccessToken();
        if (!token) {
          return;
        }
        const sourceFile = await canvasChatImageSourceToFile(imageSource, new AbortController().signal);
        const uploaded = await uploadFile(token, sourceFile, { purpose: "generated_image" });
        mediaAttachments.push({
          fileID: uploaded.file.fileID,
          fileName: uploaded.file.fileName,
          mimeType: uploaded.file.mimeType,
          detectedMime: "",
          fileCategory: "",
          sizeBytes: uploaded.file.sizeBytes,
          durationSeconds: undefined,
          kind: "image",
          processingStatus: "",
          processingReady: false,
          processingErrorCode: "",
          processingErrorMessage: "",
        });
      }
    }

    const sourceNode = state.nodes.find((node) => node.id === generateNodeID);
    if (!sourceNode || sourceNode.kind !== "generate") {
      return;
    }

    if (mediaAttachments.length === 0 && pendingArtifacts.length === 0) {
      const emptyLabel = completed.assistantMessage.errorMessage?.trim()
        || (mediaType === "video" ? (labels?.noVideoOutput ?? labels?.noImageOutput) : labels?.noImageOutput)
        || "";
      if (savingTargets.length > 0) {
        markOutputTargetsError(savingTargets, emptyLabel, rawResponse || undefined);
      } else {
        markGenerateNodeError(generateNodeID, emptyLabel, rawResponse || undefined);
      }
      clearGenerateNodeRunBinding(generateNodeID);
      return;
    }

    // 生成数量约束：仅保留前 N 个结果（视频固定 1 个）；保存待重试产物不受限（上游已生成）
    const limitedAttachments = mediaAttachments.slice(0, Math.max(1, resultCount));
    const durationMs = startedAt ? Math.max(0, Date.now() - startedAt) : undefined;
    const videoDuration = mediaType === "video"
      ? limitedAttachments.find((item) => item.durationSeconds && item.durationSeconds > 0)?.durationSeconds
      : undefined;
    const entries: GenerateResultEntry[] = limitedAttachments.map((attachment) => ({
      fileID: attachment.fileID,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      durationSeconds: attachment.durationSeconds,
    }));
    for (const pending of pendingArtifacts) {
      entries.push({ pendingRetry: pending });
    }

    if (savingTargets.length > 0) {
      writeResultsIntoTargets(savingTargets, entries, {
        prompt,
        modelName,
        durationMs,
        durationSeconds: videoDuration,
        savePendingLabel: labels?.artifactSavePending,
      });
    } else {
      writeGenerateResults(sourceNode, entries, {
        prompt,
        modelName,
        durationMs,
        durationSeconds: videoDuration,
        savePendingLabel: labels?.artifactSavePending,
      });
    }

    // 运行完成：生成节点与输出节点的任务绑定一并清除
    clearGenerateNodeRunBinding(generateNodeID);
  },

  // -------------------------------------------------------------------------
  // 刷新恢复引擎（三层兜底）：
  // ① 批量查询运行状态后对运行中的任务挂断点续传流；
  // ② 挂流不可得（任务已结束/事件缓存释放）时查任务会话消息附件捞回结果；
  // ③ 均不可得才标记错误。
  // 任务绑定在输出节点上（status running + runID + conversationID），按 runID 分组恢复；
  // 兼容旧版数据：生成节点 runStatus pending 的遗留运行仍走生成节点恢复链路。
  // -------------------------------------------------------------------------
  async resumePendingGenerations(): Promise<void> {
    // 遗留链路：运行状态仍记录在生成节点上的旧数据
    const pendingNodes = state.nodes.filter(
      (node): node is GenerateGraphNode =>
        node.kind === "generate" && node.runStatus === "pending" && Boolean(node.runID) && Boolean(node.conversationID),
    );
    // 新链路：运行状态绑定在输出节点上，按 runID 分组（一次运行对应多个输出节点）
    const outputRuns = new Map<string, { conversationID: string; mediaType: CanvasMediaType; outputIDs: string[]; sourceGenerateID: string | null }>();
    for (const node of state.nodes) {
      if (node.kind !== "output" || node.status !== "running" || !node.runID || !node.conversationID) {
        continue;
      }
      // 内存中正在运行的任务（控制器按 runID 登记）跳过
      if (abortControllers.has(node.runID)) {
        continue;
      }
      const group = outputRuns.get(node.runID);
      if (group) {
        group.outputIDs.push(node.id);
      } else {
        outputRuns.set(node.runID, {
          conversationID: node.conversationID,
          mediaType: node.mediaType ?? "image",
          outputIDs: [node.id],
          sourceGenerateID: node.sourceGenerateID ?? null,
        });
      }
    }
    if (pendingNodes.length === 0 && outputRuns.size === 0) {
      return;
    }
    const token = await resolveAccessToken();
    if (!token) {
      return;
    }
    const allRunIDs = [
      ...pendingNodes.map((node) => node.runID ?? "").filter(Boolean),
      ...[...outputRuns.keys()],
    ];
    let statuses: Map<string, string> | null = null;
    try {
      const rows = await getConversationRunStatuses(token, allRunIDs);
      statuses = new Map(rows.map((row) => [row.runID, row.status]));
    } catch {
      // 状态查询失败不阻断：挂流本身会给出结论
    }
    for (const node of pendingNodes) {
      if (abortControllers.has(node.id)) {
        continue;
      }
      const status = node.runID && statuses ? statuses.get(node.runID)?.trim().toLowerCase() : undefined;
      if (status === "running" || status === "pending" || status === undefined || status === "") {
        await canvasStore.resumeGenerateNode(node.id, token);
      } else {
        await canvasStore.restoreGenerateNodeFromConversation(node.id, token);
      }
    }
    for (const [runID, group] of outputRuns) {
      const status = statuses ? statuses.get(runID)?.trim().toLowerCase() : undefined;
      if (status === "running" || status === "pending" || status === undefined || status === "") {
        await canvasStore.resumeOutputRun(runID, group, token);
      } else {
        await canvasStore.restoreOutputRunFromConversation(group, token);
      }
    }
  },

  // 第①层（输出节点任务）：按运行 ID 重新订阅生成流，收完剩余事件后走统一收尾
  async resumeOutputRun(
    runID: string,
    group: { conversationID: string; mediaType: CanvasMediaType; outputIDs: string[]; sourceGenerateID: string | null },
    token: string,
  ): Promise<void> {
    if (abortControllers.has(runID)) {
      return;
    }
    const controller = new AbortController();
    abortControllers.set(runID, controller);
    setGeneratingDelta(1);
    try {
      const completed = await resumeMessageGenerationStream(token, runID, {
        signal: controller.signal,
        ...buildStreamOptions(group.outputIDs, group.mediaType, controller.signal, {}),
      });
      if (completed) {
        await canvasStore.completeGeneration({
          generateNodeID: group.sourceGenerateID ?? "",
          outputNodeIDs: group.outputIDs,
          prompt: completed.userMessage.content?.trim() || "",
          modelName: "",
          resultCount: group.outputIDs.length,
          mediaType: group.mediaType,
          completed,
        });
        try {
          await deleteConversation(token, group.conversationID);
        } catch {
          // 会话清理失败不影响恢复结果。
        }
      } else {
        await canvasStore.restoreOutputRunFromConversation(group, token);
      }
    } catch {
      if (!controller.signal.aborted) {
        // 第②层兜底：事件流不可得（任务已结束/缓存释放），改查任务会话消息
        await canvasStore.restoreOutputRunFromConversation(group, token);
      }
    } finally {
      abortControllers.delete(runID);
      setGeneratingDelta(-1);
    }
  },

  // 第②层兜底（输出节点任务）：任务会话未及清理（页面关闭期完成），从消息附件直接捞回结果文件
  async restoreOutputRunFromConversation(
    group: { conversationID: string; mediaType: CanvasMediaType; outputIDs: string[]; sourceGenerateID: string | null },
    token: string,
  ): Promise<void> {
    try {
      const messages = await listMessages(token, group.conversationID, 1, 20);
      const assistant = [...messages]
        .reverse()
        .find((item) => item.role === "assistant" && item.status === "success");
      if (!assistant) {
        // 第③层：消息也不可得（会话丢失），标记中断
        markOutputTargetsError(group.outputIDs, labels?.nodeGenerationInterrupted ?? "");
        await deleteConversation(token, group.conversationID).catch(() => undefined);
        return;
      }
      await canvasStore.completeGeneration({
        generateNodeID: group.sourceGenerateID ?? "",
        outputNodeIDs: group.outputIDs,
        prompt: assistant.content?.trim() || "",
        modelName: "",
        resultCount: group.outputIDs.length,
        mediaType: group.mediaType,
        completed: { assistantMessage: assistant },
      });
      try {
        await deleteConversation(token, group.conversationID);
      } catch {
        // 会话清理失败不影响恢复结果。
      }
    } catch {
      // 第③层：连消息都拿不到（网络失效/会话丢失），标记中断
      markOutputTargetsError(group.outputIDs, labels?.nodeGenerationInterrupted ?? "");
    }
  },

  // 第①层：按运行 ID 重新订阅生成流，收完剩余事件后走统一收尾
  async resumeGenerateNode(generateNodeID: string, token: string): Promise<void> {
    const node = state.nodes.find((item) => item.id === generateNodeID);
    if (!node || node.kind !== "generate" || !node.runID || !node.conversationID) {
      return;
    }
    const mediaType = node.mediaType ?? "image";
    const controller = new AbortController();
    abortControllers.set(generateNodeID, controller);
    setGeneratingDelta(1);
    try {
      const completed = await resumeMessageGenerationStream(token, node.runID, {
        signal: controller.signal,
        // 遗留链路：运行状态在生成节点上，无预分配输出节点；流事件按输出节点写入为空操作，
        // 结果在收尾时经 writeGenerateResults 按连线落位
        ...buildStreamOptions([], mediaType, controller.signal, {}),
      });
      if (completed) {
        await canvasStore.completeGeneration({
          generateNodeID,
          prompt: completed.userMessage.content?.trim() || node.model || "",
          modelName: node.model ?? "",
          resultCount: mediaType === "video" ? 1 : node.resultCount,
          mediaType,
          completed,
        });
        try {
          await deleteConversation(token, node.conversationID);
        } catch {
          // 会话清理失败不影响恢复结果。
        }
      } else {
        await canvasStore.restoreGenerateNodeFromConversation(generateNodeID, token);
      }
    } catch {
      if (!controller.signal.aborted) {
        // 第②层兜底：事件流不可得（任务已结束/缓存释放），改查任务会话消息
        await canvasStore.restoreGenerateNodeFromConversation(generateNodeID, token);
      }
    } finally {
      abortControllers.delete(generateNodeID);
      setGeneratingDelta(-1);
    }
  },

  // 第②层兜底：任务会话未及清理（页面关闭期完成），从消息附件直接捞回结果文件
  async restoreGenerateNodeFromConversation(generateNodeID: string, token: string): Promise<void> {
    const node = state.nodes.find((item) => item.id === generateNodeID);
    if (!node || node.kind !== "generate" || !node.conversationID) {
      return;
    }
    const mediaType = node.mediaType ?? "image";
    try {
      const messages = await listMessages(token, node.conversationID, 1, 20);
      const assistant = [...messages]
        .reverse()
        .find((item) => item.role === "assistant" && (item.runID === node.runID || item.status === "success"));
      if (!assistant) {
        // 第③层：消息也不可得（会话丢失），标记中断
        markGenerateNodeError(generateNodeID, labels?.nodeGenerationInterrupted ?? "");
        await deleteConversation(token, node.conversationID).catch(() => undefined);
        return;
      }
      await canvasStore.completeGeneration({
        generateNodeID,
        prompt: assistant.content?.trim() || "",
        modelName: node.model || "",
        resultCount: mediaType === "video" ? 1 : node.resultCount,
        mediaType,
        completed: { assistantMessage: assistant },
      });
      try {
        await deleteConversation(token, node.conversationID);
      } catch {
        // 会话清理失败不影响恢复结果。
      }
    } catch {
      // 第③层：连消息都拿不到（网络失效/会话丢失），标记中断
      markGenerateNodeError(generateNodeID, labels?.nodeGenerationInterrupted ?? "");
    }
  },


  // 任务重查：对失败节点按 run 记录的上游任务 ID 回查上游结果并回收产物
  async requeryGenerateNode(generateNodeID: string): Promise<void> {
    const node = state.nodes.find((item) => item.id === generateNodeID);
    if (!node || node.kind !== "generate" || !labels) {
      return;
    }
    // 优先用持久化的运行 ID；旧版本错误节点未保存运行引用时，
    // 回退到旧版确定性 runID（canvas-<节点ID>）尝试定位运行记录
    const runID = node.runID?.trim() || `canvas-${generateNodeID}`;
    if (!node.errorMessage) {
      return;
    }
    if (abortControllers.has(generateNodeID)) {
      return;
    }
    const controller = new AbortController();
    abortControllers.set(generateNodeID, controller);
    updateNode(generateNodeID, (item) =>
      item.kind === "generate" ? { ...item, statusLabel: labels?.requeryStarted ?? item.statusLabel } : item,
    );
    toast.info(labels.requeryStarted);
    try {
      const token = await resolveAccessToken();
      if (!token) {
        markGenerateNodeError(generateNodeID, labels.needLogin);
        return;
      }
      const mediaType = node.mediaType ?? "image";
      if (mediaType !== "video") {
        markGenerateNodeError(generateNodeID, node.errorMessage, node.errorDetail);
        return;
      }
      const result = await requeryMediaVideoRun(token, runID);
      if (result.status === "completed" && result.attachments && result.attachments.length > 0 && labels) {
        // 回收成功：复用统一收尾写回输出节点并复位
        const attachmentsJSON = JSON.stringify(result.attachments.map((item) => ({
          file_id: item.fileID,
          file_name: item.fileName,
          mime_type: item.mimeType,
          file_size: item.sizeBytes,
          duration_seconds: item.durationSeconds,
          kind: "file",
        })));
        await canvasStore.completeGeneration({
          generateNodeID,
          prompt: "",
          modelName: node.model ?? "",
          resultCount: 1,
          mediaType,
          completed: { assistantMessage: { attachments: attachmentsJSON } as unknown as MessageDTO },
        });
        toast.success(labels.requeryRecovered);
        return;
      }
      if (result.status === "pending") {
        // 上游仍在执行：保持错误态但更新提示，用户可稍后再次重查
        const message = labels?.requeryPending ?? "";
        updateNode(generateNodeID, (item) =>
          item.kind === "generate"
            ? { ...item, statusLabel: undefined, errorMessage: message || item.errorMessage }
            : item,
        );
        toast.info(message);
        return;
      }
      const message = result.message?.trim() || labels.requeryUnavailable;
      markGenerateNodeError(generateNodeID, message, node.errorDetail);
      toast.error(message);
    } catch (error) {
      const message = resolveLocalizedErrorMessageWithoutReference(error, labels.requeryUnavailable);
      markGenerateNodeError(generateNodeID, message, node.errorDetail);
      toast.error(message);
    } finally {
      abortControllers.delete(generateNodeID);
      updateNode(generateNodeID, (item) =>
        item.kind === "generate" && item.runStatus === "idle" ? { ...item, statusLabel: undefined } : item,
      );
    }
  },

  // 输出节点任务重查：对失败的视频输出节点按运行引用回查上游结果并回收产物到本节点。
  // 任务绑定随输出节点走：错误与重查都在输出节点上自治完成，不占用生成节点。
  async requeryOutputNode(nodeID: string): Promise<void> {
    const node = state.nodes.find((item) => item.id === nodeID);
    if (!node || node.kind !== "output" || !node.runID || !labels) {
      return;
    }
    // 未完成（运行中）的任务同样允许手动重查：上游可能已产出结果而当前流尚未收到。
    // 任务引用（runID）绑定在输出节点上，重查不会干扰仍在进行的流。
    if ((node.status !== "error" && node.status !== "running") || node.pendingRetry) {
      return;
    }
    if (abortControllers.has(nodeID)) {
      return;
    }
    const controller = new AbortController();
    abortControllers.set(nodeID, controller);
    updateNode(nodeID, (item) =>
      item.kind === "output" ? { ...item, statusLabel: labels?.requeryStarted ?? item.statusLabel } : item,
    );
    toast.info(labels.requeryStarted);
    // 重查判定为失败时统一落为错误态：运行中的节点与原本的错误节点走同一收束
    const failToError = (message: string): void => {
      updateNode(nodeID, (item) =>
        item.kind === "output"
          ? {
            ...item, status: "error", statusLabel: undefined, progress: undefined,
            previewURL: undefined, errorMessage: message, conversationID: undefined,
          }
          : item,
      );
    };
    try {
      const token = await resolveAccessToken();
      if (!token) {
        updateNode(nodeID, (item) => (item.kind === "output" ? { ...item, errorMessage: labels?.needLogin ?? "" } : item));
        return;
      }
      const mediaType = node.mediaType ?? "image";
      if (mediaType !== "video") {
        updateNode(nodeID, (item) => (item.kind === "output" ? { ...item, statusLabel: undefined } : item));
        return;
      }
      // 重查后持续监听：上游仍在生成时保持运行态与进度条，直到完成、失败或再次超出等待上限
      const deadline = Date.now() + REQUERY_WAIT_LIMIT_MS;
      let pendingNotified = false;
      let result = await requeryMediaVideoRun(token, node.runID);
      while (true) {
        if (result.status === "completed" && result.attachments && result.attachments.length > 0 && labels) {
          // 回收成功：产物直接写入本输出节点
          const attachment = result.attachments[0];
          updateNode(nodeID, (item) =>
            item.kind === "output"
              ? {
                ...item, status: "done", fileID: attachment.fileID, fileName: attachment.fileName,
                mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes,
                durationSeconds: attachment.durationSeconds, objectURL: undefined, imageLoadFailed: false,
                errorMessage: undefined, errorDetail: undefined, statusLabel: undefined,
                progress: undefined, previewURL: undefined, conversationID: undefined,
                runID: undefined, completedAt: Date.now(),
              }
              : item,
          );
          void loadOutputImage(nodeID, attachment.fileID);
          toast.success(labels.requeryRecovered);
          return;
        }
        if (result.status !== "pending") {
          break;
        }
        if (Date.now() >= deadline || controller.signal.aborted) {
          // 再次超时：与生成期等待上限同一口径，保留重新查询入口供稍后再试
          const message = labels.requeryTimeout;
          failToError(message);
          toast.error(message);
          return;
        }
        // 上游仍在生成：回到运行态并显示上游进度；上游不报进度时保持不确定态
        const percent = typeof result.progress === "number" && result.progress >= 0 ? result.progress : undefined;
        updateNode(nodeID, (item) =>
          item.kind === "output"
            ? {
              ...item, status: "running", statusLabel: labels?.requeryPending ?? item.statusLabel,
              progress: percent ?? item.progress,
              errorMessage: undefined, errorDetail: undefined,
            }
            : item,
        );
        if (!pendingNotified) {
          pendingNotified = true;
          toast.info(labels.requeryPending);
        }
        await waitForRequeryTick(controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        result = await requeryMediaVideoRun(token, node.runID);
      }
      const message = result.message?.trim() || labels.requeryUnavailable;
      failToError(message);
      toast.error(message);
    } catch (error) {
      const message = resolveLocalizedErrorMessageWithoutReference(error, labels.requeryUnavailable);
      failToError(message);
      toast.error(message);
    } finally {
      abortControllers.delete(nodeID);
      updateNode(nodeID, (item) =>
        item.kind === "output" && item.status === "error" ? { ...item, statusLabel: undefined } : item,
      );
    }
  },

  // 输出节点保存重试：产物保存待重试的输出节点自行重新保存（图像重下载 / 视频重查上游任务），
  // 成功后本节点转为完成态并加载预览；失败保持可重试状态，不占用生成节点。
  async retryOutputNodeSave(nodeID: string): Promise<void> {
    const node = state.nodes.find((item) => item.id === nodeID);
    if (!node || node.kind !== "output" || !node.pendingRetry || !labels) {
      return;
    }
    if (abortControllers.has(nodeID)) {
      return;
    }
    const controller = new AbortController();
    abortControllers.set(nodeID, controller);
    updateNode(nodeID, (item) =>
      item.kind === "output" ? { ...item, errorMessage: labels?.artifactRetrySaving ?? "", retrySaving: true } : item,
    );
    try {
      const token = await resolveAccessToken();
      if (!token) {
        updateNode(nodeID, (item) =>
          item.kind === "output" ? { ...item, errorMessage: labels?.needLogin ?? "" } : item,
        );
        return;
      }
      const retry = node.pendingRetry;
      if (retry.mediaType === "video") {
        // 视频重试复用任务重查：按上游任务 ID 回查并回收产物
        const result = await requeryMediaVideoRun(token, retry.runID);
        if (result.status === "completed" && result.attachments && result.attachments.length > 0) {
          const attachment = result.attachments[retry.index] ?? result.attachments[0];
          updateNode(nodeID, (item) =>
            item.kind === "output"
              ? {
                ...item, status: "done", fileID: attachment.fileID, fileName: attachment.fileName,
                mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes,
                durationSeconds: attachment.durationSeconds, objectURL: undefined, imageLoadFailed: false,
                errorMessage: undefined, errorDetail: undefined, pendingRetry: undefined,
                completedAt: Date.now(),
              }
              : item,
          );
          void loadOutputImage(nodeID, attachment.fileID);
          toast.success(labels.requeryRecovered);
          return;
        }
        if (result.status === "pending") {
          const message = labels.requeryPending;
          updateNode(nodeID, (item) => item.kind === "output" ? { ...item, errorMessage: message } : item);
          toast.info(message);
          return;
        }
        const message = result.message?.trim() || labels.requeryUnavailable;
        updateNode(nodeID, (item) => item.kind === "output" ? { ...item, errorMessage: message } : item);
        toast.error(message);
        return;
      }
      // 图像重试：按 runID + 产物序号重新下载保存
      const result = await retryMediaImageArtifact(token, retry.runID, retry.index);
      if (result.status === "recovered" && result.attachment) {
        const attachment = result.attachment;
        updateNode(nodeID, (item) =>
          item.kind === "output"
            ? {
              ...item, status: "done", fileID: attachment.fileID, fileName: attachment.fileName,
              mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes,
              objectURL: undefined, imageLoadFailed: false,
              errorMessage: undefined, errorDetail: undefined, pendingRetry: undefined,
              completedAt: Date.now(),
            }
            : item,
        );
        void loadOutputImage(nodeID, attachment.fileID);
        toast.success(labels.artifactRecovered);
        return;
      }
      // 引用过期：产物无法找回，移除重试引用并提示重新生成
      const message = result.message?.trim() || labels.artifactExpired;
      updateNode(nodeID, (item) =>
        item.kind === "output" ? { ...item, errorMessage: message, pendingRetry: undefined } : item,
      );
      toast.error(message);
    } catch (error) {
      // 保存仍失败：保留重试引用，输出节点可继续重试
      const message = resolveLocalizedErrorMessageWithoutReference(error, labels?.artifactRetryFailed ?? "");
      updateNode(nodeID, (item) => item.kind === "output" ? { ...item, errorMessage: message } : item);
      toast.error(message);
    } finally {
      abortControllers.delete(nodeID);
      // 统一清除重试中的瞬态标记（成功/失败分支的字段展开会携带旧值）
      updateNode(nodeID, (item) =>
        item.kind === "output" ? { ...item, retrySaving: false } : item,
      );
    }
  },

  // 图像编辑器提交：以指定输出/参考图节点为源图，创建或复用生成节点（局部重绘/裁剪/扩图）。
  // 提交后立即返回关闭编辑器，生成在画布后台进行；布局沿正向数据流成链：
  // 提示词节点在源节点正上方（生成节点左侧），源节点 -> 右侧生成节点 -> 生成结果输出节点
  async enqueueGraphEdit(input: {
    sourceNodeID: string;
    prompt: string;
    model: CanvasModelOption;
    operation: CanvasOperation;
    // 编辑器同步的分辨率参数（扩图/裁剪后的尺寸映射），写入生成节点
    sizeOptions?: ConversationOptions;
    sourceImage: CanvasNodeReference;
    maskReference: CanvasNodeReference | null;
    // 每次都新建生成节点：素材工具栏操作按预设参数开新节点并自动连线
    forceNewNode?: boolean;
  }): Promise<void> {
    const sourceNode = state.nodes.find((node) => node.id === input.sourceNodeID);
    if (!sourceNode || (sourceNode.kind !== "output" && sourceNode.kind !== "image") || !labels) {
      return;
    }
    const sourceSize = graphNodeSize(sourceNode);
    const generateSize = GRAPH_NODE_SIZES.generate;

    // 复用该源节点已连接的生成节点（取最近一条连线），否则新建；强制新建时跳过复用
    const existingEdge = input.forceNewNode
      ? undefined
      : [...state.edges]
        .filter((edge) => edge.fromNodeID === input.sourceNodeID && edge.toPort === "image")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
    const existingGenerate = existingEdge
      ? state.nodes.find((node) => node.id === existingEdge.toNodeID && node.kind === "generate")
      : undefined;

    recordGraphHistory(currentSnapshot());
    const generateNodeID = existingGenerate?.id ?? createNodeID();

    if (!existingGenerate) {
      const generateNode: GenerateGraphNode = {
        id: generateNodeID, kind: "generate", mediaType: "image",
        x: Math.round(sourceNode.x + sourceSize.width + 96),
        y: sourceNode.y + Math.round((sourceSize.height - generateSize.height) / 2),
        createdAt: Date.now(), model: input.model.platformModelName,
        modelScope: input.model.modelScope === "user" ? "user" : "platform",
        userModelID: input.model.modelScope === "user" ? input.model.userModelID : undefined,
        options: input.sizeOptions ?? {},
        resultCount: 1, operation: input.operation, maskReference: input.maskReference,
        // 编辑描述直接写进生成节点，不再额外创建文本节点
        prompt: input.prompt,
        runStatus: "idle",
      };
      setState((current) => {
        // 源节点被 Frame 承载时，新节点继承归属且 Frame 自动扩展以容纳它们
        const generateWithFrame = { ...generateNode, frameID: sourceNode.frameID ?? null };
        let decorations = current.decorations;
        if (sourceNode.frameID) {
          const frame = decorations.find((item) =>
            item.id === sourceNode.frameID && item.kind === "frame" && !item.locked && !item.collapsed);
          if (frame) {
            const newElements = [
              { id: generateNodeID, x: generateNode.x, y: generateNode.y, width: generateSize.width, height: generateSize.height },
            ];
            decorations = decorations.map((item) =>
              item.id === frame.id ? { ...item, ...frameUnionBounds(item, newElements) } : item);
          }
        }
        const nodes = [...current.nodes, generateWithFrame];
        const reconciled = reconcileFrameMembership(nodes, decorations);
        return {
          ...current,
          nodes: reconciled.nodes,
          decorations: reconciled.decorations,
          edges: [
            ...current.edges,
            { id: createNodeID(), fromNodeID: input.sourceNodeID, toNodeID: generateNodeID, toPort: "image", createdAt: Date.now() },
            // 编辑结果写回已连接的输出节点，无连线时由运行时派生新的输出节点
          ],
          canUndo: true,
          canRedo: false,
        };
      });
    } else {
      setState((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          if (node.id === generateNodeID && node.kind === "generate") {
            return {
              ...node,
              model: input.model.platformModelName,
              modelScope: input.model.modelScope === "user" ? "user" : "platform",
              userModelID: input.model.modelScope === "user" ? input.model.userModelID : undefined,
              mediaType: "image",
              operation: input.operation,
              // 复用节点时编辑器同步的分辨率参数覆盖同名配置，其余参数保留
              options: input.sizeOptions ? mergeCanvasOptions(node.options, input.sizeOptions) : node.options,
              maskReference: input.maskReference,
              prompt: input.prompt,
              runStatus: "idle",
              errorMessage: undefined,
              errorDetail: undefined,
            };
          }
          return node;
        }),
        canUndo: true,
        canRedo: false,
      }));
    }

    canvasStore.setSelectedModel(input.model);
    // 不等待生成完成：提交即返回，编辑器关闭回到画布，结果由输出节点流式接收
    void canvasStore.runGenerateNode(generateNodeID);
  },
};

type CanvasStore = typeof canvasStoreImplementation;
type CanvasGlobal = typeof globalThis & { __deeixCanvasStore?: CanvasStore };
const canvasGlobal = globalThis as CanvasGlobal;

// Next 路由分块可能重新执行模块；挂到 globalThis 后仍复用原 store 与进行中的请求。
export const canvasStore = canvasGlobal.__deeixCanvasStore ?? canvasStoreImplementation;
canvasGlobal.__deeixCanvasStore = canvasStore;
