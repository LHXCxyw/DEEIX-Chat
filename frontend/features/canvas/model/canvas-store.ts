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
  type CanvasArrangeAction,
  stableFrameIDForElement,
  nextCanvasVersion,
} from "@/features/canvas/model/canvas-interactions";
import {
  clearCanvasState,
  loadCanvasState,
  saveCanvasState,
  stringifyCanvasState,
  toPersistedNodes,
} from "@/features/canvas/model/canvas-persist";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  type CanvasBookmark,
  type CanvasDecoration,
  type CanvasNode,
  type CanvasOperation,
  type CanvasNodeReference,
  type CanvasPointerMode,
  type CanvasVersion,
  type CanvasViewport,
  type PersistedCanvasPage,
  type PersistedCanvasState,
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
  chatCapabilityRequired: string;
  imageUnsupported: string;
};

export type CanvasGenerateInput = {
  prompt: string;
  model: ChatModelOption;
  imageOptions: ConversationOptions;
  references?: CanvasNodeReference[];
  maskReference?: CanvasNodeReference | null;
  parentID?: string | null;
  operation?: CanvasOperation;
  spawnPoint?: { x: number; y: number };
};

export type CanvasState = {
  nodes: CanvasNode[];
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
  imageOptions: Record<string, ConversationOptions>;
  restoredModelName: string | null;
  generatingCount: number;
  restored: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

const initialState: CanvasState = {
  nodes: [],
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
  imageOptions: {},
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
let persistTimer: number | null = null;
let cloudPersist: ((raw: string) => void) | null = null;
let lastPersistedRaw = "";
let nodeSpawnCounter = 0;
const undoStack: CanvasNode[][] = [];
const redoStack: CanvasNode[][] = [];
let nodeMoveSnapshot: CanvasNode[] | null = null;
const HISTORY_LIMIT = 100;

function cloneNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => ({ ...node }));
}

function updateHistoryAvailability(): void {
  state = { ...state, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
}

function recordNodeHistory(nodes: CanvasNode[]): void {
  undoStack.push(cloneNodes(nodes));
  if (undoStack.length > HISTORY_LIMIT) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

function abortMissingNodes(nextNodes: CanvasNode[]): void {
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

function reconcileFrameMembership(nodes: CanvasNode[], decorations: CanvasDecoration[]) {
  const frames = decorations.filter((item) => item.kind === "frame");
  return {
    nodes: nodes.map((node) => ({
      ...node,
      frameID: stableFrameIDForElement({ ...node, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }, frames),
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

function clampScale(scale: number): number {
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, scale));
}

function currentPage(current: CanvasState): PersistedCanvasPage {
  const existing = current.canvases.find((item) => item.id === current.activeCanvasID);
  const now = Date.now();
  return {
    id: current.activeCanvasID, name: existing?.name ?? "Canvas", viewport: current.viewport,
    nodes: toPersistedNodes(current.nodes), decorations: current.decorations, bookmarks: current.bookmarks,
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
    version: 3, projectName: state.projectName, activeCanvasID: state.activeCanvasID,
    canvases: allPages(state), versions: state.versions,
    conversationID: null, selectedModelName: state.restoredModelName, pointerMode: state.pointerMode,
    viewport: state.viewport, nodes: toPersistedNodes(state.nodes), decorations: state.decorations,
    bookmarks: state.bookmarks, imageOptions: state.imageOptions,
  };
}

function schedulePersist(): void {
  if (typeof window === "undefined" || !state.restored) {
    return;
  }
  // 流式事件会高频更新；已有定时器时不重置，确保生成中节点定期真正写入。
  if (persistTimer !== null) {
    return;
  }
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const persisted = getPersistedState();
    const raw = stringifyCanvasState(persisted);
    if (raw === lastPersistedRaw) {
      return;
    }
    lastPersistedRaw = raw;
    saveCanvasState(persisted);
    cloudPersist?.(raw);
  }, 400);
}

function createNodeID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateNode(nodeID: string, updater: (node: CanvasNode) => CanvasNode): void {
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

function markNodeError(nodeID: string, errorMessage: string, errorDetail?: string): void {
  updateNode(nodeID, (node) => {
    if (node.status === "done") {
      return node;
    }
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      prompt: node.prompt,
      model: node.model,
      createdAt: node.createdAt,
      parentID: node.parentID ?? null,
      references: node.references ?? [],
      maskReference: node.maskReference ?? null,
      options: node.options,
      operation: node.operation,
      batchID: node.batchID,
      version: node.version,
      completedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - node.createdAt),
      locked: node.locked,
      groupID: node.groupID ?? null,
      frameID: node.frameID ?? null,
      zIndex: node.zIndex,
      status: "error" as const,
      errorMessage,
      errorDetail,
    };
  });
}

function setGeneratingDelta(delta: number): void {
  setState((current) => ({
    ...current,
    generatingCount: Math.max(0, current.generatingCount + delta),
  }));
}

async function loadNodeImage(nodeID: string, fileID: string): Promise<void> {
  const cached = objectURLCache.get(fileID);
  if (cached) {
    updateNode(nodeID, (node) => (node.status === "done" ? { ...node, objectURL: cached } : node));
    return;
  }
  const token = await resolveAccessToken();
  if (!token) {
    updateNode(nodeID, (node) => (node.status === "done" ? { ...node, imageLoadFailed: true } : node));
    return;
  }
  try {
    const result = await fetchFileContent(token, fileID);
    const objectURL = URL.createObjectURL(result.blob);
    objectURLCache.set(fileID, objectURL);
    updateNode(nodeID, (node) =>
      node.status === "done" ? { ...node, objectURL, imageLoadFailed: false } : node,
    );
  } catch {
    updateNode(nodeID, (node) => (node.status === "done" ? { ...node, imageLoadFailed: true } : node));
  }
}

// 新节点落点：视口中心附近轻微错位，避免完全重叠
function nextNodePosition(spawnPoint?: { x: number; y: number }): { x: number; y: number } {
  const offset = nodeSpawnCounter % 6;
  nodeSpawnCounter += 1;
  const base = spawnPoint ?? { x: 0, y: 0 };
  return {
    x: base.x - CANVAS_NODE_WIDTH / 2 + offset * 48,
    y: base.y - CANVAS_NODE_HEIGHT / 2 + offset * 40,
  };
}

// 子节点默认落在父节点右侧，多个子节点向下错开，便于连线呈现继承关系
function childNodePosition(parent: CanvasNode | undefined, spawnPoint?: { x: number; y: number }) {
  if (!parent) {
    return nextNodePosition(spawnPoint);
  }
  const siblingCount = state.nodes.filter((node) => node.parentID === parent.id).length;
  return {
    x: parent.x + CANVAS_NODE_WIDTH + 64,
    y: parent.y + siblingCount * (CANVAS_NODE_HEIGHT + 32),
  };
}

// 每个画布任务使用独立会话，避免 Chat 路由自动继承上一张图的提示词上下文。
// 请求结束后会软删除该会话但保留生成文件，左侧对话列表不会累积画布记录。
async function createTaskConversation(token: string): Promise<string> {
  const conversation = await createConversation(token, {
    title: labels?.conversationTitle ?? "Canvas",
  });
  return conversation.publicID;
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

function restoreNodes(items: PersistedCanvasState["nodes"]): CanvasNode[] {
  return items.map((item): CanvasNode => {
    const base = {
      id: item.id,
      x: item.x,
      y: item.y,
      prompt: item.prompt,
      model: item.model,
      createdAt: item.createdAt,
      parentID: item.parentID ?? null,
      references: item.references ?? [],
      maskReference: item.maskReference ?? null,
      options: item.options,
      locked: item.locked,
      groupID: item.groupID ?? null,
      zIndex: item.zIndex,
      operation: item.operation,
      batchID: item.batchID,
      version: item.version,
      completedAt: item.completedAt,
      durationMs: item.durationMs,
      frameID: item.frameID ?? null,
    };
    if (item.status === "error") {
      return {
        ...base,
        status: "error" as const,
        errorMessage: item.errorMessage ?? "",
        errorDetail: item.errorDetail,
      };
    }
    if (item.status === "pending" || item.status === "streaming") {
      return {
        ...base,
        status: "error" as const,
        errorMessage: labels?.nodeGenerationInterrupted ?? "Generation was interrupted. Please retry.",
      };
    }
    return {
      ...base,
      status: "done" as const,
      fileID: item.fileID ?? "",
      fileName: item.fileName ?? "",
      mimeType: item.mimeType ?? "image/png",
      sizeBytes: item.sizeBytes ?? 0,
    };
  });
}

function hydrateNodeImages(nodes: CanvasNode[]): void {
  for (const node of nodes) if (node.status === "done" && node.fileID) void loadNodeImage(node.id, node.fileID);
}

function restoreFromPersisted(persisted: PersistedCanvasState): void {
  const canvases = persisted.canvases ?? [];
  const activeCanvasID = persisted.activeCanvasID ?? canvases[0]?.id ?? "canvas-main";
  const active = canvases.find((item) => item.id === activeCanvasID);
  const restoredNodes = restoreNodes(active?.nodes ?? persisted.nodes);
  const restoredDecorations = active?.decorations ?? persisted.decorations ?? [];
  const reconciled = reconcileFrameMembership(restoredNodes, restoredDecorations);
  nodeSpawnCounter = restoredNodes.length;
  undoStack.length = 0;
  redoStack.length = 0;
  state = {
    ...state, nodes: reconciled.nodes, decorations: reconciled.decorations,
    bookmarks: active?.bookmarks ?? persisted.bookmarks ?? [], canvases, activeCanvasID,
    projectName: persisted.projectName ?? "Untitled project", versions: persisted.versions ?? [],
    viewport: { ...(active?.viewport ?? persisted.viewport), scale: clampScale((active?.viewport ?? persisted.viewport).scale) },
    conversationID: null, pointerMode: persisted.pointerMode, imageOptions: persisted.imageOptions,
    restoredModelName: persisted.selectedModelName, selectedNodeIDs: [], selectedDecorationIDs: [],
    restored: true, canUndo: false, canRedo: false,
  };
  lastPersistedRaw = stringifyCanvasState(persisted);
  emit();
  hydrateNodeImages(restoredNodes);
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

  seedPersistedState(persisted: PersistedCanvasState): void {
    restoreFromPersisted(persisted);
    saveCanvasState(getPersistedState());
  },

  pushCurrentStateToCloud(): void {
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
      const page: PersistedCanvasPage = { id: "canvas-main", name: "Canvas 1", viewport: state.viewport, nodes: [], decorations: [], bookmarks: [], createdAt: now, updatedAt: now };
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
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + CANVAS_NODE_WIDTH);
      maxY = Math.max(maxY, node.y + CANVAS_NODE_HEIGHT);
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
      if (current.selectedNodeIDs.length === nodeIDs.length && current.selectedNodeIDs.every((id, index) => id === nodeIDs[index])) return current;
      return { ...current, selectedNodeIDs: nodeIDs };
    });
  },

  setSelectedDecorationIDs(ids: string[]): void {
    setState((current) => current.selectedDecorationIDs.length === ids.length && current.selectedDecorationIDs.every((id, index) => id === ids[index])
      ? current
      : { ...current, selectedDecorationIDs: ids });
  },

  setProjectName(name: string): void {
    setState((current) => current.projectName === name ? current : { ...current, projectName: name });
  },

  addCanvas(name?: string): void {
    const pages = allPages(state);
    const now = Date.now();
    const id = createNodeID();
    const page: PersistedCanvasPage = { id, name: name?.trim() || `Canvas ${pages.length + 1}`, viewport: { x: 0, y: 0, scale: 1 }, nodes: [], decorations: [], bookmarks: [], createdAt: now, updatedAt: now };
    setState((current) => ({ ...current, canvases: [...pages, page], activeCanvasID: id, nodes: [], decorations: [], bookmarks: [], viewport: page.viewport, selectedNodeIDs: [], selectedDecorationIDs: [] }));
  },

  switchCanvas(canvasID: string): void {
    if (canvasID === state.activeCanvasID || state.generatingCount > 0) return;
    const pages = allPages(state);
    const target = pages.find((item) => item.id === canvasID);
    if (!target) return;
    const nodes = restoreNodes(target.nodes);
    setState((current) => ({ ...current, canvases: pages, activeCanvasID: canvasID, nodes, decorations: target.decorations, bookmarks: target.bookmarks, viewport: target.viewport, selectedNodeIDs: [], selectedDecorationIDs: [] }));
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
    const nodes = restoreNodes(target.nodes);
    setState((current) => ({ ...current, canvases: remaining, activeCanvasID: target.id, nodes, decorations: target.decorations, bookmarks: target.bookmarks, viewport: target.viewport, selectedNodeIDs: [], selectedDecorationIDs: [] }));
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
          ...current.nodes.map((node) => ({
            ...node,
            width: CANVAS_NODE_WIDTH,
            height: CANVAS_NODE_HEIGHT,
          })),
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
    setState((current) => {
      const nodes = current.nodes.filter((item) => !nodeIDs.has(item.id) || item.locked);
      const decorations = current.decorations.filter((item) => !decorationIDs.has(item.id) || item.locked);
      return { ...current, ...reconcileFrameMembership(nodes, decorations), selectedNodeIDs: [], selectedDecorationIDs: [] };
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
      ...state.nodes.map((item) => ({ ...item, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT })),
      ...state.decorations,
    ];
    const patches = arrangeCanvasElements(elements, selectedIDs, action);
    if (!patches) {
      return false;
    }
    setState((current) => {
      const nodes = current.nodes.map((item) => patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item);
      const decorations = current.decorations.map((item) => patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item);
      return { ...current, ...reconcileFrameMembership(nodes, decorations) };
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
  restoreVersion(id: string): void { const snapshot = state.versions.find((item) => item.id === id); if (!snapshot) return; const target = snapshot.canvases.find((item) => item.id === snapshot.activeCanvasID) ?? snapshot.canvases[0]; const nodes = restoreNodes(target.nodes); setState((current) => ({ ...current, canvases: snapshot.canvases, activeCanvasID: target.id, nodes, decorations: target.decorations, bookmarks: target.bookmarks, viewport: target.viewport, selectedNodeIDs: [], selectedDecorationIDs: [] })); hydrateNodeImages(nodes); },

  exportProject(): string { return JSON.stringify(getPersistedState(), null, 2); },
  importProject(persisted: PersistedCanvasState): void {
    restoreFromPersisted(persisted);
    lastPersistedRaw = "";
    schedulePersist();
  },

  applyTemplate(kind: "blank" | "storyboard" | "moodboard"): void {
    const point = { x: 0, y: 0 };
    if (kind === "blank") { setState((current) => ({ ...current, nodes: [], decorations: [], bookmarks: [], viewport: { x: 0, y: 0, scale: 1 }, selectedNodeIDs: [], selectedDecorationIDs: [] })); return; }
    const decorations: CanvasDecoration[] = kind === "storyboard"
      ? [0, 1, 2].map((index) => ({ id: createNodeID(), kind: "frame", x: point.x + index * 520, y: point.y, width: 480, height: 360, title: `Scene ${index + 1}`, text: "", color: "indigo", createdAt: Date.now(), zIndex: -10 }))
      : [{ id: createNodeID(), kind: "section", x: -420, y: -260, width: 840, height: 520, title: "Moodboard", text: "", color: "cyan", createdAt: Date.now(), zIndex: -10 }, { id: createNodeID(), kind: "note", x: 460, y: -120, width: 240, height: 160, title: "Direction", text: "Collect references and define the visual language.", color: "amber", createdAt: Date.now(), zIndex: 10 }];
    setState((current) => ({ ...current, nodes: [], decorations, bookmarks: [], viewport: { x: 0, y: 0, scale: 1 }, selectedNodeIDs: [], selectedDecorationIDs: [] }));
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

  setImageOptions(modelName: string, options: ConversationOptions): void {
    setState((current) => ({
      ...current,
      imageOptions: { ...current.imageOptions, [modelName]: options },
    }));
  },

  beginNodeMove(): void {
    if (!nodeMoveSnapshot) {
      nodeMoveSnapshot = cloneNodes(state.nodes);
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
    if (!snapshot || !snapshot.some((node, index) => {
      const current = state.nodes[index];
      return !current || current.id !== node.id || current.x !== node.x || current.y !== node.y;
    })) {
      return;
    }
    recordNodeHistory(snapshot);
    updateHistoryAvailability();
    emit();
  },

  undo(): void {
    const previous = undoStack.pop();
    if (!previous) {
      return;
    }
    abortMissingNodes(previous);
    redoStack.push(cloneNodes(state.nodes));
    setState((current) => ({
      ...current,
      nodes: cloneNodes(previous),
      selectedNodeIDs: [],
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    }));
    hydrateNodeImages(previous);
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
    recordNodeHistory(state.nodes);
    setState((current) => ({
      ...current,
      nodes: current.nodes
        .filter((node) => !removed.has(node.id))
        .map((node) => (node.parentID && removed.has(node.parentID) ? { ...node, parentID: null } : node)),
      selectedNodeIDs: current.selectedNodeIDs.filter((id) => !removed.has(id)),
      canUndo: true,
      canRedo: false,
    }));
  },

  removeNode(nodeID: string): void {
    canvasStore.removeNodes([nodeID]);
  },

  redo(): void {
    const next = redoStack.pop();
    if (!next) {
      return;
    }
    undoStack.push(cloneNodes(state.nodes));
    setState((current) => ({
      ...current,
      nodes: cloneNodes(next),
      selectedNodeIDs: [],
      canUndo: true,
      canRedo: redoStack.length > 0,
    }));
    hydrateNodeImages(next);
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
    if (state.nodes.length > 0) {
      recordNodeHistory(state.nodes);
    }
    clearCanvasState();
    lastPersistedRaw = "";
    setState((current) => ({
      ...current,
      nodes: [],
      decorations: [],
      bookmarks: [],
      selectedNodeIDs: [],
      selectedDecorationIDs: [],
      canUndo: undoStack.length > 0,
      canRedo: false,
    }));
  },

  async generate(input: CanvasGenerateInput): Promise<void> {
    const prompt = input.prompt.trim();
    if (!prompt || !labels) {
      return;
    }
    const references = input.references ?? [];
    const decision = resolveCanvasRoute(input.model, references.length > 0);
    if (decision.blockedReason) {
      toast.error(
        decision.blockedReason === "edit_reference_required"
          ? labels.editReferenceRequired
          : decision.blockedReason === "edit_unsupported"
            ? labels.editUnsupported
            : decision.blockedReason === "chat_capability_required"
              ? labels.chatCapabilityRequired
              : labels.imageUnsupported,
      );
      return;
    }

    const token = await resolveAccessToken();
    if (!token) {
      toast.error(labels.needLogin);
      return;
    }

    let conversationID: string;
    try {
      conversationID = await createTaskConversation(token);
    } catch {
      toast.error(labels.conversationCreateFailed);
      return;
    }

    const parent = input.parentID
      ? state.nodes.find((node) => node.id === input.parentID)
      : undefined;
    const position = input.parentID
      ? childNodePosition(parent, input.spawnPoint)
      : nextNodePosition(input.spawnPoint);
    const nodeID = createNodeID();
    const batchID = input.parentID ? (parent?.batchID ?? parent?.id) : nodeID;
    const version = nextCanvasVersion(state.nodes, parent);

    recordNodeHistory(state.nodes);
    setState((current) => {
      const nodes: CanvasNode[] = [
        ...current.nodes,
        {
          id: nodeID,
          x: position.x,
          y: position.y,
          prompt,
          model: input.model.platformModelName,
          createdAt: Date.now(),
          parentID: input.parentID ?? null,
          references,
          maskReference: input.maskReference ?? null,
          options: input.imageOptions,
          operation: input.operation ?? (references.length > 0 ? "edit" : "generate"),
          batchID,
          version,
          status: "pending",
          statusLabel: labels?.nodePreparing ?? "",
        },
      ];
      return { ...current, canUndo: true, canRedo: false, ...reconcileFrameMembership(nodes, current.decorations) };
    });

    await canvasStore.runGeneration({
      nodeID,
      prompt,
      model: input.model,
      imageOptions: input.imageOptions,
      references,
      maskReference: input.maskReference ?? null,
      route: decision.route,
      conversationID,
      token,
    });
  },

  async runGeneration({
    nodeID,
    prompt,
    model,
    imageOptions,
    references,
    maskReference,
    route,
    conversationID,
    token,
  }: {
    nodeID: string;
    prompt: string;
    model: ChatModelOption;
    imageOptions: ConversationOptions;
    references: CanvasNodeReference[];
    maskReference: CanvasNodeReference | null;
    route: "image_generation" | "image_edit" | "chat";
    conversationID: string;
    token: string;
  }): Promise<void> {
    const controller = new AbortController();
    abortControllers.set(nodeID, controller);
    setGeneratingDelta(1);

    const mergedOptions = mergeCanvasOptions(model.defaultOptions ?? {}, imageOptions);
    let assistantText = "";

    const streamOptions: ConversationStreamOptions = {
      signal: controller.signal,
      onMediaStatus: (event) => {
        const label = resolveStatusLabel(event.status, event.message);
        updateNode(nodeID, (node) =>
          node.status === "pending" || node.status === "streaming"
            ? { ...node, status: "streaming" as const, statusLabel: label }
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
        updateNode(nodeID, (node) =>
          node.status === "pending" || node.status === "streaming"
            ? { ...node, status: "streaming" as const, previewURL: source }
            : node,
        );
      },
      onDelta: (delta) => {
        assistantText += delta;
        updateNode(nodeID, (node) =>
          node.status === "pending"
            ? { ...node, status: "streaming" as const, statusLabel: labels?.statusRunning ?? node.statusLabel }
            : node,
        );
      },
      onModerationBlocked: () => {
        markNodeError(nodeID, labels?.moderationBlocked ?? "");
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
            clientRunID: `canvas-${nodeID}`,
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
            clientRunID: `canvas-${nodeID}`,
            fileIDs: references.length > 0 ? references.map((item) => item.fileID) : undefined,
            maskFileID: maskReference?.fileID,
          };
          return route === "image_edit"
            ? streamImageEdit(token, conversationID, payload, streamOptions)
            : streamImageGeneration(token, conversationID, payload, streamOptions);
        })());

      updateNode(nodeID, (node) =>
        node.status === "pending" || node.status === "streaming"
          ? { ...node, status: "streaming" as const, statusLabel: labels?.nodeSavingLocal ?? "" }
          : node,
      );

      const attachments = parseAttachments(completed.assistantMessage.attachments);
      const imageAttachments = attachments.filter((item) => item.kind === "image");
      const rawResponse = completed.assistantMessage.content?.trim() || assistantText.trim();

      // 部分上游会在任意生成路由中把图片放进 Markdown 文本，而不是 attachments。
      // 提取 URL / Data URL / Base64 后上传到文件服务，使画布节点仍可持久化、下载和继续编辑。
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

      if (imageAttachments.length === 0) {
        markNodeError(
          nodeID,
          completed.assistantMessage.errorMessage?.trim() || labels?.noImageOutput || "",
          rawResponse || undefined,
        );
        return;
      }
      const sourceNode = state.nodes.find((node) => node.id === nodeID);
      if (!sourceNode) {
        return;
      }
      const completedAt = Date.now();
      const durationMs = Math.max(0, completedAt - sourceNode.createdAt);
      const resultNodes = imageAttachments.map((attachment, index): CanvasNode => ({
        ...sourceNode,
        id: index === 0 ? nodeID : createNodeID(),
        x: sourceNode.x,
        y: sourceNode.y + index * (CANVAS_NODE_HEIGHT + 32),
        createdAt: sourceNode.createdAt + index,
        version: sourceNode.version ?? 1,
        completedAt,
        durationMs,
        status: "done",
        fileID: attachment.fileID,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      }));
      setState((current) => ({
        ...current,
        nodes: current.nodes.flatMap((node) => (node.id === nodeID ? resultNodes : [node])),
      }));
      for (const resultNode of resultNodes) {
        if (resultNode.status === "done") {
          void loadNodeImage(resultNode.id, resultNode.fileID);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        markNodeError(nodeID, labels?.canceled ?? "");
      } else if (error instanceof ApiError && error.errorCode === "content_moderation.blocked") {
        markNodeError(nodeID, labels?.moderationBlocked ?? "", errorDetailFromApiError(error));
      } else if (error instanceof ApiError) {
        markNodeError(
          nodeID,
          error.message || labels?.generateFailed || "",
          errorDetailFromApiError(error) ?? (assistantText.trim() || undefined),
        );
      } else {
        const message = error instanceof Error && error.message ? error.message : labels?.generateFailed || "";
        markNodeError(nodeID, message, assistantText.trim() || undefined);
      }
    } finally {
      abortControllers.delete(nodeID);
      setGeneratingDelta(-1);
      // 画布任务使用一次性会话；软删除会话但保留文件，避免左侧记录与后续上下文串联。
      try {
        await deleteConversation(token, conversationID);
      } catch {
        // 会话清理失败不影响已经完成的画布节点。
      }
    }
  },

  // 重试保留节点身份、父连线与参考图，实现“带图重试”
  async retryNode(nodeID: string, model: ChatModelOption): Promise<void> {
    const node = state.nodes.find((item) => item.id === nodeID);
    if (!node || node.status === "pending" || node.status === "streaming" || !labels) {
      return;
    }
    const references = node.references ?? [];
    const decision = resolveCanvasRoute(model, references.length > 0);
    if (decision.blockedReason) {
      toast.error(
        decision.blockedReason === "edit_reference_required"
          ? labels.editReferenceRequired
          : decision.blockedReason === "edit_unsupported"
            ? labels.editUnsupported
            : decision.blockedReason === "chat_capability_required"
              ? labels.chatCapabilityRequired
              : labels.imageUnsupported,
      );
      return;
    }
    const token = await resolveAccessToken();
    if (!token) {
      toast.error(labels.needLogin);
      return;
    }
    let conversationID: string;
    try {
      conversationID = await createTaskConversation(token);
    } catch {
      toast.error(labels.conversationCreateFailed);
      return;
    }

    updateNode(nodeID, (item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      prompt: item.prompt,
      model: model.platformModelName,
      createdAt: Date.now(),
      parentID: item.parentID ?? null,
      references,
      maskReference: item.maskReference ?? null,
      options: item.options,
      operation: item.operation,
      batchID: item.batchID,
      version: item.version,
      locked: item.locked,
      groupID: item.groupID,
      frameID: item.frameID,
      zIndex: item.zIndex,
      status: "pending" as const,
      statusLabel: labels?.nodePreparing ?? "",
    }));

    await canvasStore.runGeneration({
      nodeID,
      prompt: node.prompt,
      model,
      imageOptions: node.options ?? {},
      references,
      maskReference: node.maskReference ?? null,
      route: decision.route,
      conversationID,
      token,
    });
  },
};

type CanvasStore = typeof canvasStoreImplementation;
type CanvasGlobal = typeof globalThis & { __deeixCanvasStore?: CanvasStore };
const canvasGlobal = globalThis as CanvasGlobal;

// Next 路由分块可能重新执行模块；挂到 globalThis 后仍复用原 store 与进行中的请求。
export const canvasStore = canvasGlobal.__deeixCanvasStore ?? canvasStoreImplementation;
canvasGlobal.__deeixCanvasStore = canvasStore;
