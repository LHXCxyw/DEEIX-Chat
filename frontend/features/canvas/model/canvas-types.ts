import type { ConversationOptions } from "@/shared/api/conversation.types";

export type CanvasNodeStatus = "pending" | "streaming" | "done" | "error";
export type CanvasPointerMode = "pan" | "select";
export type CanvasNodeReference = { fileID: string; fileName: string; mimeType: string; sizeBytes: number };
export type CanvasOperation = "generate" | "edit" | "inpaint" | "outpaint" | "crop";
export type CanvasElementMeta = { locked?: boolean; groupID?: string | null; frameID?: string | null; zIndex?: number };

export type CanvasNodeBase = CanvasElementMeta & {
  id: string; x: number; y: number; prompt: string; model: string; createdAt: number;
  parentID?: string | null; reference?: CanvasNodeReference | null; references?: CanvasNodeReference[];
  maskReference?: CanvasNodeReference | null; options?: ConversationOptions; operation?: CanvasOperation;
  batchID?: string; version?: number; completedAt?: number; durationMs?: number;
};
export type CanvasGeneratingNode = CanvasNodeBase & { status: "pending" | "streaming"; statusLabel: string; previewURL?: string };
export type CanvasDoneNode = CanvasNodeBase & { status: "done"; fileID: string; fileName: string; mimeType: string; sizeBytes: number; objectURL?: string; imageLoadFailed?: boolean };
export type CanvasErrorNode = CanvasNodeBase & { status: "error"; errorMessage: string; errorDetail?: string };
export type CanvasNode = CanvasGeneratingNode | CanvasDoneNode | CanvasErrorNode;

export type CanvasDecoration = CanvasElementMeta & {
  id: string;
  kind: "frame" | "section" | "note";
  x: number; y: number; width: number; height: number;
  title: string; text: string; color: string; createdAt: number; collapsed?: boolean;
};
export type CanvasViewport = { x: number; y: number; scale: number };
export type CanvasBookmark = { id: string; name: string; viewport: CanvasViewport; createdAt: number };

export type PersistedCanvasNode = {
  id: string; x: number; y: number; prompt: string; model: string; createdAt: number;
  status: CanvasNodeStatus; parentID?: string | null; reference?: CanvasNodeReference | null;
  references?: CanvasNodeReference[]; maskReference?: CanvasNodeReference | null; operation?: CanvasOperation;
  batchID?: string; version?: number; completedAt?: number; durationMs?: number; options?: ConversationOptions; fileID?: string; fileName?: string;
  mimeType?: string; sizeBytes?: number; errorMessage?: string; errorDetail?: string;
  locked?: boolean; groupID?: string | null; frameID?: string | null; zIndex?: number;
};
export type PersistedCanvasPage = {
  id: string; name: string; viewport: CanvasViewport; nodes: PersistedCanvasNode[];
  decorations: CanvasDecoration[]; bookmarks: CanvasBookmark[]; createdAt: number; updatedAt: number;
};
export type CanvasVersion = { id: string; name: string; createdAt: number; activeCanvasID: string; canvases: PersistedCanvasPage[] };
export type PersistedCanvasState = {
  version?: 3;
  projectName?: string;
  activeCanvasID?: string;
  canvases?: PersistedCanvasPage[];
  versions?: CanvasVersion[];
  conversationID: string | null;
  selectedModelName: string | null;
  pointerMode: CanvasPointerMode;
  viewport: CanvasViewport;
  nodes: PersistedCanvasNode[];
  decorations?: CanvasDecoration[];
  bookmarks?: CanvasBookmark[];
  imageOptions: Record<string, ConversationOptions>;
};

export const CANVAS_NODE_WIDTH = 288;
export const CANVAS_NODE_HEIGHT = 340;
export const CANVAS_GRID_SIZE = 8;
export const CANVAS_MIN_SCALE = 0.2;
export const CANVAS_MAX_SCALE = 4;
export const CANVAS_STORAGE_KEY = "deeix_canvas_state_v3";
export const CANVAS_LEGACY_STORAGE_KEY = "deeix_canvas_state_v2";
export const CANVAS_CLOUD_SETTING_KEY = "canvas.state_v1";
export const CANVAS_UI_ATTRIBUTE = "data-canvas-ui";
export function snapToGrid(value: number): number { return Math.round(value / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE; }
