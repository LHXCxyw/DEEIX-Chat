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
  type CanvasNode,
  type CanvasNodeReference,
  type CanvasPointerMode,
  type CanvasViewport,
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
  reference?: CanvasNodeReference | null;
  parentID?: string | null;
  spawnPoint?: { x: number; y: number };
};

export type CanvasState = {
  nodes: CanvasNode[];
  viewport: CanvasViewport;
  conversationID: string | null;
  pointerMode: CanvasPointerMode;
  selectedNodeIDs: string[];
  imageOptions: Record<string, ConversationOptions>;
  restoredModelName: string | null;
  generatingCount: number;
  restored: boolean;
};

const initialState: CanvasState = {
  nodes: [],
  viewport: { x: 0, y: 0, scale: 1 },
  conversationID: null,
  pointerMode: "pan",
  selectedNodeIDs: [],
  imageOptions: {},
  restoredModelName: null,
  generatingCount: 0,
  restored: false,
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

function clampScale(scale: number): number {
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, scale));
}

function getPersistedState(): PersistedCanvasState {
  return {
    conversationID: state.conversationID,
    selectedModelName: state.restoredModelName,
    pointerMode: state.pointerMode,
    viewport: state.viewport,
    nodes: toPersistedNodes(state.nodes),
    imageOptions: state.imageOptions,
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
      reference: node.reference ?? null,
      options: node.options,
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

function restoreFromPersisted(persisted: PersistedCanvasState): void {
  const restoredNodes = persisted.nodes.map((item): CanvasNode => {
    const base = {
      id: item.id,
      x: item.x,
      y: item.y,
      prompt: item.prompt,
      model: item.model,
      createdAt: item.createdAt,
      parentID: item.parentID ?? null,
      reference: item.reference ?? null,
      options: item.options,
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
  nodeSpawnCounter = restoredNodes.length;
  state = {
    ...state,
    nodes: restoredNodes,
    viewport: { x: persisted.viewport.x, y: persisted.viewport.y, scale: clampScale(persisted.viewport.scale) },
    conversationID: null,
    pointerMode: persisted.pointerMode,
    imageOptions: persisted.imageOptions,
    restoredModelName: persisted.selectedModelName,
    restored: true,
  };
  lastPersistedRaw = stringifyCanvasState(persisted);
  emit();
  for (const node of restoredNodes) {
    if (node.status === "done" && node.fileID) {
      void loadNodeImage(node.id, node.fileID);
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

  seedPersistedState(persisted: PersistedCanvasState): void {
    if (state.restored) {
      return;
    }
    restoreFromPersisted(persisted);
    saveCanvasState(persisted);
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
      setState((current) => ({ ...current, restored: true }));
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
    const nodes = state.nodes;
    if (nodes.length === 0 || containerSize.width <= 0 || containerSize.height <= 0) {
      canvasStore.resetViewport();
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + CANVAS_NODE_WIDTH);
      maxY = Math.max(maxY, node.y + CANVAS_NODE_HEIGHT);
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
      if (
        current.selectedNodeIDs.length === nodeIDs.length &&
        current.selectedNodeIDs.every((id, index) => id === nodeIDs[index])
      ) {
        return current;
      }
      return { ...current, selectedNodeIDs: nodeIDs };
    });
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

  moveNodes(positionList: { nodeID: string; x: number; y: number }[]): void {
    const positions = new Map(positionList.map((item) => [item.nodeID, item]));
    setState((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, x: position.x, y: position.y } : node;
      }),
    }));
  },

  removeNode(nodeID: string): void {
    const controller = abortControllers.get(nodeID);
    if (controller) {
      controller.abort();
      abortControllers.delete(nodeID);
    }
    setState((current) => ({
      ...current,
      // 断开父引用，避免出现悬空连线
      nodes: current.nodes
        .filter((node) => node.id !== nodeID)
        .map((node) => (node.parentID === nodeID ? { ...node, parentID: null } : node)),
      selectedNodeIDs: current.selectedNodeIDs.filter((id) => id !== nodeID),
    }));
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
    clearCanvasState();
    setState((current) => ({ ...current, nodes: [], selectedNodeIDs: [] }));
  },

  async generate(input: CanvasGenerateInput): Promise<void> {
    const prompt = input.prompt.trim();
    if (!prompt || !labels) {
      return;
    }
    const decision = resolveCanvasRoute(input.model, Boolean(input.reference));
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

    setState((current) => ({
      ...current,
      nodes: [
        ...current.nodes,
        {
          id: nodeID,
          x: position.x,
          y: position.y,
          prompt,
          model: input.model.platformModelName,
          createdAt: Date.now(),
          parentID: input.parentID ?? null,
          reference: input.reference ?? null,
          options: input.imageOptions,
          status: "pending" as const,
          statusLabel: labels?.nodePreparing ?? "",
        },
      ],
    }));

    await canvasStore.runGeneration({
      nodeID,
      prompt,
      model: input.model,
      imageOptions: input.imageOptions,
      reference: input.reference ?? null,
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
    reference,
    route,
    conversationID,
    token,
  }: {
    nodeID: string;
    prompt: string;
    model: ChatModelOption;
    imageOptions: ConversationOptions;
    reference: CanvasNodeReference | null;
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
            contentType: reference ? "mixed" : "text",
            knowledgeBaseIDs: [],
            model: model.platformModelName,
            modelScope: model.modelScope === "user" ? "user" : undefined,
            userModelID: model.modelScope === "user" ? model.userModelID : undefined,
            options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
            clientRunID: `canvas-${nodeID}`,
            fileIDs: reference ? [reference.fileID] : undefined,
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
            fileIDs: reference ? [reference.fileID] : undefined,
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
      let imageAttachment = attachments.find((item) => item.kind === "image");
      const rawResponse = completed.assistantMessage.content?.trim() || assistantText.trim();

      // 部分上游会在任意生成路由中把图片放进 Markdown 文本，而不是 attachments。
      // 提取 URL / Data URL / Base64 后上传到文件服务，使画布节点仍可持久化、下载和继续编辑。
      if (!imageAttachment && rawResponse) {
        const imageSource = resolveCanvasChatImageSource(rawResponse);
        if (imageSource) {
          const sourceFile = await canvasChatImageSourceToFile(imageSource, controller.signal);
          const uploaded = await uploadFile(token, sourceFile, { purpose: "generated_image" });
          imageAttachment = {
            fileID: uploaded.file.fileID,
            fileName: uploaded.file.fileName,
            mimeType: uploaded.file.mimeType,
            sizeBytes: uploaded.file.sizeBytes,
            kind: "image",
          };
        }
      }

      if (!imageAttachment) {
        markNodeError(
          nodeID,
          completed.assistantMessage.errorMessage?.trim() || labels?.noImageOutput || "",
          rawResponse || undefined,
        );
        return;
      }
      const finalImageAttachment = imageAttachment;

      updateNode(nodeID, (node) => ({
        id: node.id,
        x: node.x,
        y: node.y,
        prompt: node.prompt,
        model: node.model,
        createdAt: node.createdAt,
        parentID: node.parentID ?? null,
        reference: node.reference ?? null,
        options: node.options,
        status: "done" as const,
        fileID: finalImageAttachment.fileID,
        fileName: finalImageAttachment.fileName,
        mimeType: finalImageAttachment.mimeType,
        sizeBytes: finalImageAttachment.sizeBytes,
      }));
      void loadNodeImage(nodeID, finalImageAttachment.fileID);
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
    const reference = node.reference ?? null;
    const decision = resolveCanvasRoute(model, Boolean(reference));
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
      createdAt: item.createdAt,
      parentID: item.parentID ?? null,
      reference,
      options: item.options,
      status: "pending" as const,
      statusLabel: labels?.nodePreparing ?? "",
    }));

    await canvasStore.runGeneration({
      nodeID,
      prompt: node.prompt,
      model,
      imageOptions: node.options ?? {},
      reference,
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
