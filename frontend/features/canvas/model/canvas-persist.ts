import type {
  CanvasNode,
  CanvasNodeReference,
  CanvasPointerMode,
  PersistedCanvasNode,
  PersistedCanvasState,
} from "@/features/canvas/model/canvas-types";
import { CANVAS_STORAGE_KEY } from "@/features/canvas/model/canvas-types";
import type { ConversationOptions } from "@/shared/api/conversation.types";

// 所有节点均落盘；生成中的任务由内存 store 继续，整页重载后转为可重试的中断节点。
export function toPersistedNodes(nodes: CanvasNode[]): PersistedCanvasNode[] {
  return nodes.flatMap((node): PersistedCanvasNode[] => {
    const base = {
      id: node.id,
      x: node.x,
      y: node.y,
      prompt: node.prompt,
      model: node.model,
      createdAt: node.createdAt,
      parentID: node.parentID ?? null,
      reference: node.reference ?? null,
      options: node.options,
    };
    if (node.status === "done") {
      return [
        {
          ...base,
          status: "done",
          fileID: node.fileID,
          fileName: node.fileName,
          mimeType: node.mimeType,
          sizeBytes: node.sizeBytes,
        },
      ];
    }
    if (node.status === "error") {
      return [
        {
          ...base,
          status: "error",
          errorMessage: node.errorMessage,
          errorDetail: node.errorDetail,
        },
      ];
    }
    return [
      {
        ...base,
        status: node.status,
      },
    ];
  });
}

export function stringifyCanvasState(state: PersistedCanvasState): string {
  return JSON.stringify(state);
}

export function saveCanvasState(state: PersistedCanvasState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CANVAS_STORAGE_KEY, stringifyCanvasState(state));
  } catch {
    // 存储失败时静默降级（隐私模式/配额超限）
  }
}

function parseReference(value: unknown): CanvasNodeReference | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const source = value as Partial<CanvasNodeReference>;
  if (typeof source.fileID !== "string" || !source.fileID) {
    return null;
  }
  return {
    fileID: source.fileID,
    fileName: typeof source.fileName === "string" ? source.fileName : "",
    mimeType: typeof source.mimeType === "string" ? source.mimeType : "",
    sizeBytes: typeof source.sizeBytes === "number" ? source.sizeBytes : 0,
  };
}

function parseOptions(value: unknown): ConversationOptions | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as ConversationOptions;
}

function parsePersistedNode(value: unknown): PersistedCanvasNode | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const item = value as Partial<PersistedCanvasNode>;
  if (
    typeof item.id !== "string" ||
    typeof item.x !== "number" ||
    typeof item.y !== "number" ||
    typeof item.prompt !== "string" ||
    typeof item.model !== "string" ||
    typeof item.createdAt !== "number"
  ) {
    return null;
  }
  const status = item.status === "error"
    ? "error"
    : item.status === "pending" || item.status === "streaming"
      ? item.status
      : "done";
  const base = {
    id: item.id,
    x: item.x,
    y: item.y,
    prompt: item.prompt,
    model: item.model,
    createdAt: item.createdAt,
    parentID: typeof item.parentID === "string" ? item.parentID : null,
    reference: parseReference(item.reference),
    options: parseOptions(item.options),
  };
  if (status === "error") {
    return {
      ...base,
      status: "error",
      errorMessage: typeof item.errorMessage === "string" ? item.errorMessage : "",
      errorDetail: typeof item.errorDetail === "string" ? item.errorDetail : undefined,
    };
  }
  if (status === "pending" || status === "streaming") {
    return {
      ...base,
      status,
    };
  }
  if (typeof item.fileID !== "string" || !item.fileID) {
    return null;
  }
  return {
    ...base,
    status: "done",
    fileID: item.fileID,
    fileName: typeof item.fileName === "string" ? item.fileName : "",
    mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
    sizeBytes: typeof item.sizeBytes === "number" ? item.sizeBytes : 0,
  };
}

function parseImageOptions(value: unknown): Record<string, ConversationOptions> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const options = parseOptions(item);
      return options ? [[key, options] as const] : [];
    }),
  );
}

export function parseCanvasState(raw: string): PersistedCanvasState | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const source = parsed as Partial<PersistedCanvasState>;
    if (!Array.isArray(source.nodes)) {
      return null;
    }
    const nodes = source.nodes.flatMap((item) => {
      const node = parsePersistedNode(item);
      return node ? [node] : [];
    });
    const pointerMode: CanvasPointerMode = source.pointerMode === "select" ? "select" : "pan";
    return {
      conversationID: typeof source.conversationID === "string" ? source.conversationID : null,
      selectedModelName: typeof source.selectedModelName === "string" ? source.selectedModelName : null,
      pointerMode,
      viewport: {
        x: Number.isFinite(source.viewport?.x) ? (source.viewport?.x as number) : 0,
        y: Number.isFinite(source.viewport?.y) ? (source.viewport?.y as number) : 0,
        scale: Number.isFinite(source.viewport?.scale) ? (source.viewport?.scale as number) : 1,
      },
      nodes,
      imageOptions: parseImageOptions(source.imageOptions),
    };
  } catch {
    return null;
  }
}

export function loadCanvasState(): PersistedCanvasState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CANVAS_STORAGE_KEY);
    return raw ? parseCanvasState(raw) : null;
  } catch {
    return null;
  }
}

export function clearCanvasState(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(CANVAS_STORAGE_KEY);
  } catch {
    // 忽略清理失败
  }
}

export function clampViewportScale(scale: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, scale));
}
