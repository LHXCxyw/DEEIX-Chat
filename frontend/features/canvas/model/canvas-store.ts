import { toast } from "sonner";

import { parseAttachments } from "@/features/chat/model/chat-thread";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import {
  canvasChatImageSourceToFile,
  resolveCanvasChatImageSource,
} from "@/features/canvas/model/canvas-chat-image";
import {
  chatImagePromptSuffix,
  isChatRouteImageModel,
  mergeCanvasOptions,
  resolveCanvasRoute,
} from "@/features/canvas/model/canvas-image-options";
import {
  arrangeCanvasElements,
  canvasElementIDsCarriedByFrame,
  frameUnionBounds,
  refitFrameDecorations,
  stableFrameIDForElement,
  type CanvasArrangeAction,
  type FrameRefitElement,
} from "@/features/canvas/model/canvas-interactions";
import {
  gatherGraphGenerateInputs,
  graphGenerateHasInputs,
  canConnectGraphNodes,
  type GraphConnectionAttempt,
} from "@/features/canvas/model/canvas-graph";
import type { GraphNodeUpdate } from "@/features/canvas/model/canvas-types";
import {
  clearCanvasState,
  loadCanvasState,
  restoreEdges,
  restoreGraphNodes,
  saveCanvasState,
  stringifyCanvasState,
  toPersistedEdges,
  toPersistedGraphNodes,
} from "@/features/canvas/model/canvas-persist";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasBookmark,
  type CanvasDecoration,
  type CanvasNodeReference,
  type CanvasOperation,
  type CanvasPointerMode,
  type CanvasVersion,
  type CanvasViewport,
  type GenerateGraphNode,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  type ImageGraphNode,
  type OutputGraphNode,
  type PersistedCanvasPage,
  type PersistedCanvasState,
  type PromptGraphNode,
  GRAPH_NODE_SIZES,
  graphNodeSize,
} from "@/features/canvas/model/canvas-types";
import {
  createConversation,
  deleteConversation,
  streamImageEdit,
  streamImageGeneration,
  streamMessage,
} from "@/shared/api/conversation";
import type { ConversationStreamOptions } from "@/shared/api/conversation";
import type {
  ConversationOptions,
  MediaImageRequest,
  SendMessageRequest,
} from "@/shared/api/conversation.types";
import { fetchFileContent, uploadFile } from "@/shared/api/file";
import { ApiError } from "@/shared/api/http-client";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

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
  generateFailed: string;
  canceled: string;
  moderationBlocked: string;
  noImageOutput: string;
  editReferenceRequired: string;
  editUnsupported: string;
  imageUnsupported: string;
  noImageModels: string;
  missingPromptInput: string;
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
  selectedNodeIDs: string[];
  selectedDecorationIDs: string[];
  selectedEdgeIDs: string[];
  restoredModelName: string | null;
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
  selectedNodeIDs: [],
  selectedDecorationIDs: [],
  selectedEdgeIDs: [],
  restoredModelName: null,
  generatingCount: 0,
  restored: false,
  canUndo: false,
  canRedo: false,
};

let state: CanvasState = initialState;
const listeners = new Set<() => void>();
const objectURLCache = new Map<string, string>();
const abortControllers = new Map<string, AbortController>();
let labels: CanvasStoreLabels | null = null;
let modelCatalog: ChatModelOption[] = [];
let persistTimer: number | null = null;
let cloudPersist: ((raw: string) => void) | null = null;
let lastPersistedRaw = "";
let nodeSpawnCounter = 0;
type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };
const undoStack: GraphSnapshot[] = [];
const redoStack: GraphSnapshot[] = [];
let nodeMoveSnapshot: GraphSnapshot | null = null;
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

function setState(updater: (current: CanvasState) => CanvasState): void {
  const next = updater(state);
  if (next === state) {
    return;
  }
  state = next;
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
    // Section 是最底层分区标记，不参与 Frame 承载（历史遗留的 frameID 一并清除）
    decorations: decorations.map((item) => item.kind === "section"
      ? (item.frameID ? { ...item, frameID: null } : item)
      : item.kind === "frame" ? item : ({
        ...item,
        frameID: stableFrameIDForElement(item, frames),
      })),
  };
}

function stableFrameIDForGraphNode(node: GraphNode, frames: ReadonlyArray<CanvasDecoration>): string | null {
  const size = graphNodeSize(node);
  return stableFrameIDForElement({ ...node, width: size.width, height: size.height }, frames);
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
    version: 4, savedAt: Date.now(), projectName: state.projectName, activeCanvasID: state.activeCanvasID,
    canvases: allPages(state), versions: state.versions,
    conversationID: null, selectedModelName: state.restoredModelName, pointerMode: state.pointerMode,
    viewport: state.viewport, graphNodes: toPersistedGraphNodes(state.nodes), edges: toPersistedEdges(state.edges),
    decorations: state.decorations, bookmarks: state.bookmarks, imageOptions: {},
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
  cloudPersist?.(raw);
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

function resolveStatusLabel(status: string, fallback: string): string {
  switch (status.trim()) {
    case "queued":
      return labels?.statusQueued ?? fallback;
    case "running":
      return labels?.statusRunning ?? fallback;
    case "saving_artifact":
      return labels?.statusSavingArtifact ?? fallback;
    default:
      return fallback.trim() || status.trim();
  }
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
    updateNode(nodeID, (node) => (node.kind === "output" ? { ...node, objectURL: cached, imageLoadFailed: false } : node));
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
        ? { ...node, objectURL, imageLoadFailed: false }
        : node,
    );
  } catch {
    updateNode(nodeID, (node) => (node.kind === "output" && node.fileID === fileID ? { ...node, imageLoadFailed: true } : node));
  }
}

// 参考图节点预览加载：本地预览地址缺失（刷新恢复、跨节点拖入）时按 fileID 拉取
async function loadImageNodePreview(nodeID: string, fileID: string): Promise<void> {
  const cached = objectURLCache.get(fileID);
  if (cached) {
    updateNode(nodeID, (node) => (node.kind === "image" && node.reference?.fileID === fileID
      ? { ...node, previewURL: cached, previewLoading: false, previewFailed: false }
      : node));
    return;
  }
  updateNode(nodeID, (node) => (node.kind === "image" && node.reference?.fileID === fileID
    ? { ...node, previewLoading: true, previewFailed: false }
    : node));
  const token = await resolveAccessToken();
  if (!token) {
    updateNode(nodeID, (node) => (node.kind === "image" && node.reference?.fileID === fileID
      ? { ...node, previewLoading: false, previewFailed: true }
      : node));
    return;
  }
  try {
    const result = await fetchFileContent(token, fileID);
    const objectURL = URL.createObjectURL(result.blob);
    objectURLCache.set(fileID, objectURL);
    updateNode(nodeID, (node) => (node.kind === "image" && node.reference?.fileID === fileID
      ? { ...node, previewURL: objectURL, previewLoading: false, previewFailed: false }
      : node));
  } catch {
    updateNode(nodeID, (node) => (node.kind === "image" && node.reference?.fileID === fileID
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

function errorDetailFromApiError(error: ApiError): string | undefined {
  const parts = [error.rawMessage?.trim() || "", error.errorCode ? `errorCode: ${error.errorCode}` : ""];
  if (error.details !== undefined && error.details !== null) {
    try {
      parts.push(JSON.stringify(error.details, null, 2));
    } catch {
      parts.push(String(error.details));
    }
  }
  const detail = parts.filter(Boolean).join("\n");
  return detail || undefined;
}

function hydrateNodeImages(nodes: ReadonlyArray<GraphNode>): void {
  for (const node of nodes) {
    if (node.kind === "output" && node.status === "done" && node.fileID) {
      void loadOutputImage(node.id, node.fileID);
    }
    if (node.kind === "image" && node.reference && !node.previewURL && !node.previewLoading) {
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

// 忽略 savedAt 后的状态内容指纹：判断两端画布内容是否真正一致
function comparableCanvasState(persisted: PersistedCanvasState): string {
  return JSON.stringify({ ...persisted, savedAt: 0 });
}

function restoreFromPersisted(persisted: PersistedCanvasState): void {
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
    viewport: { ...(active?.viewport ?? persisted.viewport), scale: clampScale((active?.viewport ?? persisted.viewport).scale) },
    conversationID: null, pointerMode: persisted.pointerMode,
    restoredModelName: persisted.selectedModelName, selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [],
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

// 将生成结果写入下游输出节点：优先复用已连接的输出节点（重复生成时覆盖写入同一节点，
// 不再派生新节点），连接数量不足时才在生成节点右侧派生新的输出节点并连线
function writeGenerateResults(
  generateNode: GenerateGraphNode,
  attachments: { fileID: string; fileName: string; mimeType: string; sizeBytes: number }[],
  context: { prompt: string; modelName: string; durationMs: number },
): void {
  const size = GRAPH_NODE_SIZES.output;
  const generateSize = graphNodeSize(generateNode);
  setState((current) => {
    const connectedTargets = current.edges
      .filter((edge) => edge.fromNodeID === generateNode.id && edge.toPort === "result")
      .map((edge) => current.nodes.find((node) => node.id === edge.toNodeID))
      .filter((node): node is OutputGraphNode => node?.kind === "output")
      .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));

    const nodes: GraphNode[] = [...current.nodes];
    const edges: GraphEdge[] = [...current.edges];
    const completedAt = Date.now();

    // 按纵向顺序复用已连接的输出节点承接本次结果，不足时继续派生
    const targets: OutputGraphNode[] = connectedTargets.slice(0, attachments.length);
    const outputX = generateNode.x + generateSize.width + 96;
    const bottomY = connectedTargets.length > 0
      ? Math.max(...connectedTargets.map((target) => target.y + size.height))
      : generateNode.y + Math.round((generateSize.height - size.height) / 2);
    let nextSpawnY = bottomY;
    const spawned: OutputGraphNode[] = [];
    while (targets.length < attachments.length) {
      const outputID = createNodeID();
      const outputNode: OutputGraphNode = {
        id: outputID, kind: "output", x: outputX,
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
      const attachment = attachments[targetIndex];
      const next: OutputGraphNode = attachment
        ? {
          ...node, status: "done", fileID: attachment.fileID, fileName: attachment.fileName,
          mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, objectURL: undefined,
          imageLoadFailed: false, prompt: context.prompt, model: context.modelName,
          sourceGenerateID: generateNode.id, errorMessage: undefined, errorDetail: undefined,
          completedAt, durationMs: context.durationMs,
        }
        // 输出节点多于结果时重置为空状态
        : { ...node, status: "empty", fileID: undefined, fileName: undefined, mimeType: undefined, sizeBytes: undefined, objectURL: undefined, imageLoadFailed: false, errorMessage: undefined, errorDetail: undefined, sourceGenerateID: generateNode.id };
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
  setModelCatalog(models: ChatModelOption[]): void {
    modelCatalog = models;
  },

  resolveModel(modelName: string | null): ChatModelOption | null {
    if (modelCatalog.length === 0) {
      return null;
    }
    const exact = modelName ? modelCatalog.find((item) => item.platformModelName === modelName) : null;
    return exact ?? modelCatalog[0];
  },

  seedPersistedState(persisted: PersistedCanvasState): void {
    // 内存态必须先从本地恢复：后续的内容比较与云端回推都要基于真实内容，
    // 否则未恢复时会把空画布当成本地最新状态（导致画布空白/云端被清空）
    if (!state.restored) {
      canvasStore.restore();
    }
    // 云端快照可能落后于本地（推送延迟或页面关闭时丢尾）：
    // 仅当云端快照更新时才采用，否则保留本地状态并把当前状态回推云端
    const local = loadCanvasState();
    const localSavedAt = local?.savedAt ?? 0;
    const cloudSavedAt = persisted.savedAt ?? 0;
    // 内容一致（仅 savedAt 时间戳差异）时只对齐时间戳，不重建状态：
    // 否则多端轮询会因时间戳互相抬升而反复"采纳"相同内容，表现为页面突然重置
    if (local && comparableCanvasState(local) === comparableCanvasState(persisted)) {
      if (cloudSavedAt > localSavedAt) {
        const preserved = { ...local, savedAt: cloudSavedAt };
        lastPersistedRaw = stringifyCanvasState(preserved);
        saveCanvasState(preserved);
      }
      return;
    }
    if (localSavedAt > 0 && cloudSavedAt < localSavedAt) {
      canvasStore.pushCurrentStateToCloud();
      return;
    }
    restoreFromPersisted(persisted);
    // 采用云端内容时保留其 savedAt，避免拉取本身抬升时间戳造成另一端误判
    const preserved = { ...getPersistedState(), savedAt: cloudSavedAt };
    lastPersistedRaw = stringifyCanvasState(preserved);
    saveCanvasState(preserved);
  },

  pushCurrentStateToCloud(): void {
    // 未恢复的内存态是空画布：直接推送会用空快照覆盖云端真实内容（数据丢失）
    if (!state.restored) {
      canvasStore.restore();
    }
    cloudPersist?.(stringifyCanvasState(getPersistedState()));
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
      setState((current) => ({ ...current, canvases: [page], activeCanvasID: page.id, restored: true }));
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

  addDecoration(kind: CanvasDecoration["kind"], point: { x: number; y: number }): void {
    const isNote = kind === "note";
    const item: CanvasDecoration = { id: createNodeID(), kind, x: point.x - (isNote ? 110 : 240), y: point.y - (isNote ? 70 : 160), width: isNote ? 220 : 480, height: isNote ? 140 : 320, title: kind === "frame" ? "Frame" : kind === "section" ? "Section" : "Note", text: isNote ? "Double-click to edit" : "", color: kind === "section" ? "cyan" : kind === "note" ? "amber" : "indigo", createdAt: Date.now(), zIndex: isNote ? 10 : -10 };
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

  groupSelected(): void {
    if (state.selectedNodeIDs.length + state.selectedDecorationIDs.length < 2) return;
    const groupID = createNodeID();
    const nodes = new Set(state.selectedNodeIDs); const decorations = new Set(state.selectedDecorationIDs);
    setState((current) => ({ ...current, nodes: current.nodes.map((item) => nodes.has(item.id) ? { ...item, groupID } : item), decorations: current.decorations.map((item) => decorations.has(item.id) ? { ...item, groupID } : item) }));
  },

  ungroupSelected(): void {
    const groups = new Set([...state.nodes.filter((item) => state.selectedNodeIDs.includes(item.id)).map((item) => item.groupID), ...state.decorations.filter((item) => state.selectedDecorationIDs.includes(item.id)).map((item) => item.groupID)].filter(Boolean));
    setState((current) => ({ ...current, nodes: current.nodes.map((item) => groups.has(item.groupID) ? { ...item, groupID: null } : item), decorations: current.decorations.map((item) => groups.has(item.groupID) ? { ...item, groupID: null } : item) }));
  },

  toggleLockSelected(): void {
    const nodes = new Set(state.selectedNodeIDs); const decorations = new Set(state.selectedDecorationIDs);
    const selected = [...state.nodes.filter((item) => nodes.has(item.id)), ...state.decorations.filter((item) => decorations.has(item.id))];
    const lock = selected.some((item) => !item.locked);
    setState((current) => ({ ...current, nodes: current.nodes.map((item) => nodes.has(item.id) ? { ...item, locked: lock } : item), decorations: current.decorations.map((item) => decorations.has(item.id) ? { ...item, locked: lock } : item) }));
  },

  arrangeSelected(action: CanvasArrangeAction): boolean {
    const selectedIDs = new Set([...state.selectedNodeIDs, ...state.selectedDecorationIDs]);
    const elements = [
      ...state.nodes.map((item) => ({ ...item, ...graphNodeSize(item) })),
      ...state.decorations,
    ];
    const patches = arrangeCanvasElements(elements, selectedIDs, action);
    if (!patches) {
      return false;
    }
    setState((current) => {
      const nodes = current.nodes.map((item) => patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item);
      const decorations = current.decorations.map((item) => patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item);
      const reconciled = reconcileFrameMembership(nodes, decorations);
      return {
        ...current,
        ...reconciled,
        decorations: refitFrameDecorations(
          frameRefitElements(current.nodes, current.decorations),
          frameRefitElements(reconciled.nodes, reconciled.decorations),
          reconciled.decorations,
        ),
      };
    });
    return true;
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

  applyTemplate(kind: "blank" | "storyboard" | "moodboard"): void {
    const point = { x: 0, y: 0 };
    if (kind === "blank") { setState((current) => ({ ...current, nodes: [], edges: [], decorations: [], bookmarks: [], viewport: { x: 0, y: 0, scale: 1 }, selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [] })); return; }
    const decorations: CanvasDecoration[] = kind === "storyboard"
      ? [0, 1, 2].map((index) => ({ id: createNodeID(), kind: "frame", x: point.x + index * 520, y: point.y, width: 480, height: 360, title: `Scene ${index + 1}`, text: "", color: "indigo", createdAt: Date.now(), zIndex: -10 }))
      : [{ id: createNodeID(), kind: "section", x: -420, y: -260, width: 840, height: 520, title: "Moodboard", text: "", color: "cyan", createdAt: Date.now(), zIndex: -10 }, { id: createNodeID(), kind: "note", x: 460, y: -120, width: 240, height: 160, title: "Direction", text: "Collect references and define the visual language.", color: "amber", createdAt: Date.now(), zIndex: 10 }];
    setState((current) => ({ ...current, nodes: [], edges: [], decorations, bookmarks: [], viewport: { x: 0, y: 0, scale: 1 }, selectedNodeIDs: [], selectedDecorationIDs: [], selectedEdgeIDs: [] }));
  },

  // 仅在模型确实选中时记录，避免目录加载完成前把持久化模型名清空
  setModelName(modelName: string | null): void {
    if (!modelName) {
      return;
    }
    setState((current) =>
      current.restoredModelName === modelName ? current : { ...current, restoredModelName: modelName },
    );
  },

  // -------------------------------------------------------------------------
  // 图节点 CRUD
  // -------------------------------------------------------------------------
  addGraphNode(kind: GraphNodeKind, point?: { x: number; y: number }): string {
    const nodeID = createNodeID();
    const position = nextNodePosition(kind, point);
    const base = { id: nodeID, kind, x: position.x, y: position.y, createdAt: Date.now() };
    let node: GraphNode;
    if (kind === "prompt") {
      node = { ...base, kind: "prompt", text: "" } satisfies PromptGraphNode;
    } else if (kind === "image") {
      node = { ...base, kind: "image", reference: null } satisfies ImageGraphNode;
    } else if (kind === "generate") {
      node = {
        ...base, kind: "generate", model: state.restoredModelName, options: {}, resultCount: 1,
        operation: "generate", maskReference: null, runStatus: "idle",
      } satisfies GenerateGraphNode;
    } else {
      node = { ...base, kind: "output", status: "empty" } satisfies OutputGraphNode;
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
    updateNode(nodeID, (node) => ({ ...node, ...patch, id: node.id, kind: node.kind }) as GraphNode);
  },

  // 参考图节点预览缺失时按 fileID 拉取（刷新恢复、跨节点拖入后由视图触发）
  ensureNodeImagePreview(nodeID: string): void {
    const node = state.nodes.find((item) => item.id === nodeID);
    if (node?.kind === "image" && node.reference && !node.previewURL && !node.previewLoading) {
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

  connectGraphNodes(attempt: GraphConnectionAttempt): boolean {
    const decision = canConnectGraphNodes(state.nodes, state.edges, attempt);
    if (!decision.ok) {
      return false;
    }
    recordGraphHistory(currentSnapshot());
    setState((current) => ({
      ...current,
      edges: [...current.edges, { id: createNodeID(), fromNodeID: attempt.fromNodeID, toNodeID: attempt.toNodeID, toPort: attempt.toPort, createdAt: Date.now() }],
      selectedEdgeIDs: [],
      canUndo: true,
      canRedo: false,
    }));
    return true;
  },

  removeEdge(edgeID: string): void {
    if (!state.edges.some((edge) => edge.id === edgeID)) {
      return;
    }
    recordGraphHistory(currentSnapshot());
    setState((current) => ({
      ...current,
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
    abortControllers.get(nodeID)?.abort();
  },

  clearCanvas(): void {
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    abortControllers.clear();
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
  async runGenerateNode(generateNodeID: string): Promise<void> {
    const generateNode = state.nodes.find((node) => node.id === generateNodeID);
    if (!generateNode || generateNode.kind !== "generate" || !labels) {
      return;
    }
    if (abortControllers.has(generateNodeID)) {
      return;
    }
    const inputs = gatherGraphGenerateInputs(generateNodeID, state.nodes, state.edges);
    const model = canvasStore.resolveModel(generateNode.model);
    if (!model) {
      markGenerateNodeError(generateNodeID, labels.noImageModels);
      toast.error(labels.noImageModels);
      return;
    }
    if (!graphGenerateHasInputs(inputs)) {
      markGenerateNodeError(generateNodeID, labels.missingPromptInput);
      return;
    }
    const references = inputs.references;
    const decision = resolveCanvasRoute(model, references.length > 0);
    if (decision.blockedReason) {
      const message = decision.blockedReason === "edit_reference_required"
        ? labels.editReferenceRequired
        : decision.blockedReason === "edit_unsupported"
          ? labels.editUnsupported
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

    const prompt = inputs.prompt;
    const operation: CanvasOperation = references.length > 0 && generateNode.operation === "generate"
      ? "edit"
      : generateNode.operation;
    const startedAt = Date.now();

    updateNode(generateNodeID, (node) => {
      if (node.kind !== "generate") {
        return node;
      }
      return {
        ...node,
        model: model.platformModelName,
        operation,
        runStatus: "pending",
        statusLabel: labels?.nodePreparing ?? "",
        previewURL: undefined,
        errorMessage: undefined,
        errorDetail: undefined,
      };
    });

    await canvasStore.runGeneration({
      generateNodeID,
      prompt,
      model,
      options: generateNode.options,
      resultCount: generateNode.resultCount,
      references,
      maskReference: generateNode.maskReference ?? null,
      operation,
      outputEdges: inputs.outputEdges,
      route: decision.route,
      conversationID,
      token,
      startedAt,
    });
  },

  async runGeneration({
    generateNodeID,
    prompt,
    model,
    options,
    resultCount,
    references,
    maskReference,
    operation,
    outputEdges,
    route,
    conversationID,
    token,
    startedAt,
  }: {
    generateNodeID: string;
    prompt: string;
    model: ChatModelOption;
    options: ConversationOptions;
    resultCount: number;
    references: CanvasNodeReference[];
    maskReference: CanvasNodeReference | null;
    operation: CanvasOperation;
    outputEdges: GraphEdge[];
    route: "image_generation" | "image_edit" | "chat";
    conversationID: string;
    token: string;
    startedAt: number;
  }): Promise<void> {
    const controller = new AbortController();
    abortControllers.set(generateNodeID, controller);
    setGeneratingDelta(1);

    const mergedOptions = mergeCanvasOptions(model.defaultOptions ?? {}, options);
    let assistantText = "";

    const streamOptions: ConversationStreamOptions = {
      signal: controller.signal,
      onMediaStatus: (event) => {
        const label = resolveStatusLabel(event.status, event.message);
        updateNode(generateNodeID, (node) =>
          node.kind === "generate" && (node.runStatus === "pending" || node.runStatus === "streaming")
            ? { ...node, runStatus: "streaming", statusLabel: label }
            : node,
        );
      },
      onMediaImageDelta: (event) => {
        const b64 = event.b64_json.trim();
        if (!b64) {
          return;
        }
        const source = b64.startsWith("data:")
          ? b64
          : `data:${event.mime_type?.trim() || "image/png"};base64,${b64}`;
        updateNode(generateNodeID, (node) =>
          node.kind === "generate" && (node.runStatus === "pending" || node.runStatus === "streaming")
            ? { ...node, runStatus: "streaming", previewURL: source }
            : node,
        );
      },
      onDelta: (delta) => {
        assistantText += delta;
        updateNode(generateNodeID, (node) =>
          node.kind === "generate" && node.runStatus === "pending"
            ? { ...node, runStatus: "streaming", statusLabel: labels?.statusRunning ?? node.statusLabel }
            : node,
        );
      },
      onModerationBlocked: () => {
        markGenerateNodeError(generateNodeID, labels?.moderationBlocked ?? "");
      },
    };

    try {
      const completed = await (route === "chat"
        ? streamMessage(
          token,
          conversationID,
          {
            content: isChatRouteImageModel(model)
              ? `${prompt}${chatImagePromptSuffix(mergedOptions)}`
              : prompt,
            contentType: references.length > 0 ? "mixed" : "text",
            knowledgeBaseIDs: [],
            model: model.platformModelName,
            modelScope: model.modelScope === "user" ? "user" : undefined,
            userModelID: model.modelScope === "user" ? model.userModelID : undefined,
            options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
            clientRunID: `canvas-${generateNodeID}`,
            fileIDs: references.length > 0 ? references.map((item) => item.fileID) : undefined,
          } satisfies SendMessageRequest,
          streamOptions,
        )
        : (() => {
          const payload: MediaImageRequest = {
            prompt,
            model: model.platformModelName,
            modelScope: model.modelScope === "user" ? "user" : undefined,
            userModelID: model.modelScope === "user" ? model.userModelID : undefined,
            options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
            clientRunID: `canvas-${generateNodeID}`,
            fileIDs: references.length > 0 ? references.map((item) => item.fileID) : undefined,
            maskFileID: maskReference?.fileID,
          };
          return route === "image_edit"
            ? streamImageEdit(token, conversationID, payload, streamOptions)
            : streamImageGeneration(token, conversationID, payload, streamOptions);
        })());

      updateNode(generateNodeID, (node) =>
        node.kind === "generate" && (node.runStatus === "pending" || node.runStatus === "streaming")
          ? { ...node, runStatus: "streaming", statusLabel: labels?.nodeSavingLocal ?? "" }
          : node,
      );

      const attachments = parseAttachments(completed.assistantMessage.attachments);
      const imageAttachments = attachments.filter((item) => item.kind === "image");
      const rawResponse = completed.assistantMessage.content?.trim() || assistantText.trim();

      // 部分上游会在任意生成路由中把图片放进 Markdown 文本，而不是 attachments。
      // 提取 URL / Data URL / Base64 后上传到文件服务，使输出节点仍可持久化、下载和继续编辑。
      if (imageAttachments.length === 0 && rawResponse) {
        const imageSource = resolveCanvasChatImageSource(rawResponse);
        if (imageSource) {
          const sourceFile = await canvasChatImageSourceToFile(imageSource, controller.signal);
          const uploaded = await uploadFile(token, sourceFile, { purpose: "generated_image" });
          imageAttachments.push({
            fileID: uploaded.file.fileID,
            fileName: uploaded.file.fileName,
            mimeType: uploaded.file.mimeType,
            sizeBytes: uploaded.file.sizeBytes,
            kind: "image",
          });
        }
      }

      const sourceNode = state.nodes.find((node) => node.id === generateNodeID);
      if (!sourceNode || sourceNode.kind !== "generate") {
        return;
      }

      if (imageAttachments.length === 0) {
        markGenerateNodeError(
          generateNodeID,
          completed.assistantMessage.errorMessage?.trim() || labels?.noImageOutput || "",
          rawResponse || undefined,
        );
        return;
      }

      // 生成数量约束：仅保留前 N 张结果
      const limitedAttachments = imageAttachments.slice(0, Math.max(1, resultCount));
      const durationMs = Math.max(0, Date.now() - startedAt);
      writeGenerateResults(sourceNode, limitedAttachments, {
        prompt,
        modelName: model.platformModelName,
        durationMs,
      });

      // 运行完成：生成节点回到空闲态
      updateNode(generateNodeID, (node) =>
        node.kind === "generate"
          ? { ...node, runStatus: "idle", statusLabel: undefined, previewURL: undefined, errorMessage: undefined, errorDetail: undefined }
          : node,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        markGenerateNodeError(generateNodeID, labels?.canceled ?? "");
      } else if (error instanceof ApiError && error.errorCode === "content_moderation.blocked") {
        markGenerateNodeError(generateNodeID, labels?.moderationBlocked ?? "", errorDetailFromApiError(error));
      } else if (error instanceof ApiError) {
        markGenerateNodeError(
          generateNodeID,
          error.message || labels?.generateFailed || "",
          errorDetailFromApiError(error) ?? (assistantText.trim() || undefined),
        );
      } else {
        const message = error instanceof Error && error.message ? error.message : labels?.generateFailed || "";
        markGenerateNodeError(generateNodeID, message, assistantText.trim() || undefined);
      }
    } finally {
      abortControllers.delete(generateNodeID);
      setGeneratingDelta(-1);
      // 画布任务使用一次性会话；软删除会话但保留文件，避免左侧记录与后续上下文串联。
      try {
        await deleteConversation(token, conversationID);
      } catch {
        // 会话清理失败不影响已经完成的画布节点。
      }
    }
  },

  // 图像编辑器提交：以指定输出/参考图节点为源图，创建或复用生成节点（局部重绘/裁剪/扩图）。
  // 提交后立即返回关闭编辑器，生成在画布后台进行；布局沿正向数据流成链：
  // 提示词节点在源节点正上方（生成节点左侧），源节点 -> 右侧生成节点 -> 生成结果输出节点
  async enqueueGraphEdit(input: {
    sourceNodeID: string;
    prompt: string;
    model: ChatModelOption;
    operation: CanvasOperation;
    // 编辑器同步的分辨率参数（扩图/裁剪后的尺寸映射），写入生成节点
    sizeOptions?: ConversationOptions;
    sourceImage: CanvasNodeReference;
    maskReference: CanvasNodeReference | null;
  }): Promise<void> {
    const sourceNode = state.nodes.find((node) => node.id === input.sourceNodeID);
    if (!sourceNode || (sourceNode.kind !== "output" && sourceNode.kind !== "image") || !labels) {
      return;
    }
    const sourceSize = graphNodeSize(sourceNode);
    const generateSize = GRAPH_NODE_SIZES.generate;
    const promptSize = GRAPH_NODE_SIZES.prompt;

    // 复用该源节点已连接的生成节点（取最近一条连线），否则新建
    const existingEdge = [...state.edges]
      .filter((edge) => edge.fromNodeID === input.sourceNodeID && edge.toPort === "image")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const existingGenerate = existingEdge
      ? state.nodes.find((node) => node.id === existingEdge.toNodeID && node.kind === "generate")
      : undefined;

    recordGraphHistory(currentSnapshot());
    const generateNodeID = existingGenerate?.id ?? createNodeID();

    if (!existingGenerate) {
      const generateNode: GenerateGraphNode = {
        id: generateNodeID, kind: "generate",
        x: Math.round(sourceNode.x + sourceSize.width + 96),
        y: sourceNode.y + Math.round((sourceSize.height - generateSize.height) / 2),
        createdAt: Date.now(), model: input.model.platformModelName,
        options: input.sizeOptions ?? {},
        resultCount: 1, operation: input.operation, maskReference: input.maskReference,
        runStatus: "idle",
      };
      const promptNodeID = createNodeID();
      // 提示词节点放在源节点（参考图/输出图）正上方、生成节点左侧：
      // 形成提示词/源图纵向对齐在左、生成节点在右的清晰工作流结构
      const promptNode: PromptGraphNode = {
        id: promptNodeID, kind: "prompt",
        x: Math.round(sourceNode.x + (sourceSize.width - promptSize.width) / 2),
        y: sourceNode.y - promptSize.height - 72,
        createdAt: Date.now(), text: input.prompt,
      };
      setState((current) => {
        // 源节点被 Frame 承载时，新节点继承归属且 Frame 自动扩展以容纳它们
        const generateWithFrame = { ...generateNode, frameID: sourceNode.frameID ?? null };
        const promptWithFrame = { ...promptNode, frameID: sourceNode.frameID ?? null };
        let decorations = current.decorations;
        if (sourceNode.frameID) {
          const frame = decorations.find((item) =>
            item.id === sourceNode.frameID && item.kind === "frame" && !item.locked && !item.collapsed);
          if (frame) {
            const newElements = [
              { id: generateNodeID, x: generateNode.x, y: generateNode.y, width: generateSize.width, height: generateSize.height },
              { id: promptNodeID, x: promptNode.x, y: promptNode.y, width: promptSize.width, height: promptSize.height },
            ];
            decorations = decorations.map((item) =>
              item.id === frame.id ? { ...item, ...frameUnionBounds(item, newElements) } : item);
          }
        }
        const nodes = [...current.nodes, generateWithFrame, promptWithFrame];
        const reconciled = reconcileFrameMembership(nodes, decorations);
        return {
          ...current,
          nodes: reconciled.nodes,
          decorations: reconciled.decorations,
          edges: [
            ...current.edges,
            { id: createNodeID(), fromNodeID: input.sourceNodeID, toNodeID: generateNodeID, toPort: "image", createdAt: Date.now() },
            { id: createNodeID(), fromNodeID: promptNodeID, toNodeID: generateNodeID, toPort: "prompt", createdAt: Date.now() + 1 },
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
              operation: input.operation,
              // 复用节点时编辑器同步的分辨率参数覆盖同名配置，其余参数保留
              options: input.sizeOptions ? mergeCanvasOptions(node.options, input.sizeOptions) : node.options,
              maskReference: input.maskReference,
              runStatus: "idle",
              errorMessage: undefined,
              errorDetail: undefined,
            };
          }
          // 复用已连接的提示词节点：更新其文本为编辑器输入
          const promptEdge = current.edges.find((edge) => edge.toNodeID === generateNodeID && edge.toPort === "prompt" && edge.fromNodeID === node.id);
          if (promptEdge && node.kind === "prompt") {
            return { ...node, text: input.prompt };
          }
          return node;
        }),
        canUndo: true,
        canRedo: false,
      }));
    }

    canvasStore.setModelName(input.model.platformModelName);
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
