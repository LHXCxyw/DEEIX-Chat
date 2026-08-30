import type { ConversationOptions } from "@/shared/api/conversation.types";

export type CanvasNodeStatus = "pending" | "streaming" | "done" | "error";

// 画布指针模式：拖动平移 / 框选节点
export type CanvasPointerMode = "pan" | "select";

// 生成来源引用（参考图），用于图像编辑与重试续传
export type CanvasNodeReference = {
  fileID: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type CanvasNodeBase = {
  id: string;
  x: number;
  y: number;
  prompt: string;
  model: string;
  createdAt: number;
  // 父节点：由某张图继续编辑或重试而来
  parentID?: string | null;
  reference?: CanvasNodeReference | null;
  options?: ConversationOptions;
};

export type CanvasGeneratingNode = CanvasNodeBase & {
  status: "pending" | "streaming";
  statusLabel: string;
  previewURL?: string;
};

export type CanvasDoneNode = CanvasNodeBase & {
  status: "done";
  fileID: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  objectURL?: string;
  imageLoadFailed?: boolean;
};

export type CanvasErrorNode = CanvasNodeBase & {
  status: "error";
  errorMessage: string;
  // 上游原始响应（文本或调试载荷），供卡片展开查看
  errorDetail?: string;
};

export type CanvasNode = CanvasGeneratingNode | CanvasDoneNode | CanvasErrorNode;

export type CanvasViewport = {
  x: number;
  y: number;
  scale: number;
};

// 持久化时仅保留可恢复字段，objectURL 等运行时资源不落盘
export type PersistedCanvasNode = {
  id: string;
  x: number;
  y: number;
  prompt: string;
  model: string;
  createdAt: number;
  status: "pending" | "streaming" | "done" | "error";
  parentID?: string | null;
  reference?: CanvasNodeReference | null;
  options?: ConversationOptions;
  fileID?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  errorMessage?: string;
  errorDetail?: string;
};

export type PersistedCanvasState = {
  conversationID: string | null;
  selectedModelName: string | null;
  pointerMode: CanvasPointerMode;
  viewport: CanvasViewport;
  nodes: PersistedCanvasNode[];
  imageOptions: Record<string, ConversationOptions>;
};

export const CANVAS_NODE_WIDTH = 288;
export const CANVAS_NODE_HEIGHT = 340;
export const CANVAS_GRID_SIZE = 8;
export const CANVAS_MIN_SCALE = 0.2;
export const CANVAS_MAX_SCALE = 4;
export const CANVAS_STORAGE_KEY = "deeix_canvas_state_v2";
// 覆盖层元素标记：命中时不触发画布缩放/平移
export const CANVAS_UI_ATTRIBUTE = "data-canvas-ui";

export function snapToGrid(value: number): number {
  return Math.round(value / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
}
