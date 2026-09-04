import type { ConversationOptions } from "@/shared/api/conversation.types";
import type {
  CanvasBookmark,
  CanvasDecoration,
  CanvasNodeReference,
  CanvasOperation,
  CanvasPointerMode,
  CanvasVersion,
  GenerateGraphNode,
  GraphEdge,
  GraphInputPort,
  GraphNode,
  GraphNodeKind,
  ImageGraphNode,
  OutputGraphNode,
  PersistedCanvasNode,
  PersistedCanvasPage,
  PersistedCanvasState,
  PersistedGraphEdge,
  PersistedGraphNode,
  PromptGraphNode,
} from "./canvas-types.ts";
import { CANVAS_LEGACY_STORAGE_KEY, CANVAS_MAX_SCALE, CANVAS_MIN_SCALE, CANVAS_STORAGE_KEY } from "./canvas-types.ts";

// ---------------------------------------------------------------------------
// 序列化：运行时图节点 -> 持久化结构（剥离 objectURL 等运行时字段）
// ---------------------------------------------------------------------------
export function toPersistedGraphNodes(nodes: ReadonlyArray<GraphNode>): PersistedGraphNode[] {
  // biome-ignore lint/suspicious/useIterableCallbackReturn: switch 按 kind 穷尽所有节点类型
  return nodes.map((node): PersistedGraphNode => {
    const meta = { id: node.id, kind: node.kind, x: node.x, y: node.y, createdAt: node.createdAt, locked: node.locked, groupID: node.groupID ?? null, frameID: node.frameID ?? null, zIndex: node.zIndex };
    switch (node.kind) {
      case "prompt":
        return { ...meta, kind: "prompt", text: node.text };
      case "image":
        return { ...meta, kind: "image", reference: node.reference };
      case "generate":
        return {
          ...meta, kind: "generate", model: node.model, options: node.options, resultCount: node.resultCount,
          operation: node.operation, maskReference: node.maskReference ?? null,
          errorMessage: node.errorMessage, errorDetail: node.errorDetail,
        };
      case "output":
        return {
          ...meta, kind: "output", status: node.status, fileID: node.fileID, fileName: node.fileName,
          mimeType: node.mimeType, sizeBytes: node.sizeBytes, prompt: node.prompt, model: node.model,
          sourceGenerateID: node.sourceGenerateID ?? null, errorMessage: node.errorMessage,
          errorDetail: node.errorDetail, completedAt: node.completedAt, durationMs: node.durationMs,
        };
    }
  });
}

export function toPersistedEdges(edges: ReadonlyArray<GraphEdge>): PersistedGraphEdge[] {
  return edges.map((edge) => ({ ...edge }));
}

export function stringifyCanvasState(state: PersistedCanvasState): string { return JSON.stringify(state); }
export function saveCanvasState(state: PersistedCanvasState): void { if (typeof window !== "undefined") try { localStorage.setItem(CANVAS_STORAGE_KEY, stringifyCanvasState(state)); } catch {} }

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------
function obj(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function finite(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function identifier(value: unknown): string { return text(value) || `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function viewport(value: unknown) { const v = obj(value); return { x: finite(v?.x), y: finite(v?.y), scale: clampViewportScale(finite(v?.scale, 1), CANVAS_MIN_SCALE, CANVAS_MAX_SCALE) }; }
function reference(value: unknown): CanvasNodeReference | null { const v = obj(value); return v && text(v.fileID) ? { fileID: text(v.fileID), fileName: text(v.fileName), mimeType: text(v.mimeType), sizeBytes: finite(v.sizeBytes) } : null; }
function options(value: unknown): ConversationOptions | undefined { return obj(value) as ConversationOptions | null ?? undefined; }
function operationOf(value: unknown): CanvasOperation { return value === "edit" || value === "inpaint" || value === "outpaint" || value === "crop" ? value : "generate"; }
function metaOf(v: Record<string, unknown>) {
  return { id: identifier(v.id), x: finite(v.x), y: finite(v.y), createdAt: finite(v.createdAt, Date.now()), locked: v.locked === true, groupID: text(v.groupID) || null, frameID: text(v.frameID) || null, zIndex: finite(v.zIndex) };
}

// 解析单个图节点；非法数据返回 null
export function graphNode(value: unknown): PersistedGraphNode | null {
  const v = obj(value);
  if (!v) return null;
  const kind = v.kind;
  const meta = metaOf(v);
  if (kind === "prompt") {
    return { ...meta, kind: "prompt", text: text(v.text) };
  }
  if (kind === "image") {
    return { ...meta, kind: "image", reference: reference(v.reference) };
  }
  if (kind === "generate") {
    return {
      ...meta, kind: "generate", model: text(v.model) || null, options: options(v.options) ?? {},
      resultCount: Math.min(4, Math.max(1, Math.round(finite(v.resultCount, 1)))),
      operation: operationOf(v.operation), maskReference: reference(v.maskReference),
      errorMessage: text(v.errorMessage) || undefined, errorDetail: text(v.errorDetail) || undefined,
    };
  }
  if (kind === "output") {
    const status = v.status === "done" && text(v.fileID) ? "done" : v.status === "error" ? "error" : "empty";
    return {
      ...meta, kind: "output", status,
      fileID: text(v.fileID) || undefined, fileName: text(v.fileName) || undefined,
      mimeType: text(v.mimeType, "image/png") || undefined, sizeBytes: finite(v.sizeBytes) || undefined,
      prompt: text(v.prompt) || undefined, model: text(v.model) || undefined,
      sourceGenerateID: text(v.sourceGenerateID) || null,
      errorMessage: text(v.errorMessage) || undefined, errorDetail: text(v.errorDetail) || undefined,
      completedAt: finite(v.completedAt) || undefined, durationMs: finite(v.durationMs) || undefined,
    };
  }
  return null;
}

export function graphEdge(value: unknown, validNodeIDs: ReadonlySet<string>): PersistedGraphEdge | null {
  const v = obj(value);
  if (!v) return null;
  const fromNodeID = text(v.fromNodeID);
  const toNodeID = text(v.toNodeID);
  const toPort = v.toPort;
  if (!fromNodeID || !toNodeID || !validNodeIDs.has(fromNodeID) || !validNodeIDs.has(toNodeID)) return null;
  if (toPort !== "prompt" && toPort !== "image" && toPort !== "result") return null;
  return { id: identifier(v.id), fromNodeID, toNodeID, toPort: toPort as GraphInputPort, createdAt: finite(v.createdAt, Date.now()) };
}

function graphNodesOf(value: unknown): PersistedGraphNode[] {
  return Array.isArray(value) ? value.flatMap((item) => { const parsed = graphNode(item); return parsed ? [parsed] : []; }) : [];
}

function edgesOf(value: unknown, validNodeIDs: ReadonlySet<string>): PersistedGraphEdge[] {
  return Array.isArray(value) ? value.flatMap((item) => { const parsed = graphEdge(item, validNodeIDs); return parsed ? [parsed] : []; }) : [];
}

// ---------------------------------------------------------------------------
// v3 -> v4 迁移：旧图像卡片映射为输出节点（保留图像与元数据）
// ---------------------------------------------------------------------------
export function legacyNodeToGraphNodes(item: PersistedCanvasNode): PersistedGraphNode[] {
  const meta = { id: item.id, x: item.x, y: item.y, createdAt: item.createdAt, locked: item.locked, groupID: item.groupID ?? null, frameID: item.frameID ?? null, zIndex: item.zIndex };
  const output: PersistedGraphNode = item.status === "done" && item.fileID
    ? {
      ...meta, kind: "output" as const, status: "done" as const,
      fileID: item.fileID, fileName: item.fileName || "image.png", mimeType: item.mimeType || "image/png",
      sizeBytes: item.sizeBytes || 0, prompt: item.prompt, model: item.model,
      completedAt: item.completedAt, durationMs: item.durationMs,
    }
    : {
      ...meta, kind: "output" as const, status: "error" as const,
      prompt: item.prompt, model: item.model,
      errorMessage: item.errorMessage || "生成任务已中断，请重试", errorDetail: item.errorDetail,
      completedAt: item.completedAt, durationMs: item.durationMs,
    };
  // 旧节点的提示词与参考图降级保留：提示词存入输出节点元数据，参考图附在输出节点上不再派生新节点
  return [output];
}

function legacyNode(value: unknown): PersistedCanvasNode | null {
  const v = obj(value); if (!v || !text(v.id) || !Number.isFinite(v.x) || !Number.isFinite(v.y) || typeof v.prompt !== "string" || typeof v.model !== "string") return null;
  const status = v.status === "error" ? "error" : v.status === "pending" || v.status === "streaming" ? v.status : "done";
  if (status === "done" && !text(v.fileID)) return null;
  const references = Array.isArray(v.references) ? v.references.flatMap((x) => { const item = reference(x); return item ? [item] : []; }) : [];
  const legacyReference = reference(v.reference);
  return { id: text(v.id), x: finite(v.x), y: finite(v.y), prompt: text(v.prompt), model: text(v.model), createdAt: finite(v.createdAt, Date.now()), status, parentID: text(v.parentID) || null, reference: legacyReference, references: references.length ? references : legacyReference ? [legacyReference] : [], maskReference: reference(v.maskReference), options: options(v.options), operation: operationOf(v.operation), batchID: text(v.batchID) || undefined, version: finite(v.version, 1), completedAt: finite(v.completedAt) || undefined, durationMs: finite(v.durationMs) || undefined, fileID: text(v.fileID) || undefined, fileName: text(v.fileName), mimeType: text(v.mimeType, "image/png"), sizeBytes: finite(v.sizeBytes), errorMessage: text(v.errorMessage), errorDetail: text(v.errorDetail) || undefined, locked: v.locked === true, groupID: text(v.groupID) || null, frameID: text(v.frameID) || null, zIndex: finite(v.zIndex) };
}

// 兼容读取迁移函数（v2/v3 数据解析后统一走 legacyNodeToGraphNodes）
export function toPersistedNodes(nodes: PersistedCanvasNode[]): PersistedCanvasNode[] { return nodes; }
export function legacyGraphNodesOf(value: unknown): PersistedGraphNode[] {
  return Array.isArray(value)
    ? value.flatMap((item) => { const legacy = legacyNode(item); return legacy ? legacyNodeToGraphNodes(legacy) : []; })
    : [];
}

function decoration(value: unknown): CanvasDecoration | null { const v = obj(value); const kind = v?.kind; if (!v || (kind !== "frame" && kind !== "section" && kind !== "note")) return null; return { id: identifier(v.id), kind, x: finite(v.x), y: finite(v.y), width: Math.max(120, finite(v.width, 320)), height: Math.max(80, finite(v.height, 200)), title: text(v.title), text: text(v.text), color: text(v.color, "indigo"), createdAt: finite(v.createdAt, Date.now()), collapsed: v.collapsed === true, locked: v.locked === true, groupID: text(v.groupID) || null, frameID: text(v.frameID) || null, zIndex: finite(v.zIndex, kind === "note" ? 10 : -10) }; }
function bookmark(value: unknown): CanvasBookmark | null { const v = obj(value); return v ? { id: identifier(v.id), name: text(v.name, "Bookmark"), viewport: viewport(v.viewport), createdAt: finite(v.createdAt, Date.now()) } : null; }

function page(value: unknown, index: number): PersistedCanvasPage | null {
  const v = obj(value); if (!v) return null;
  // v4 页面优先读取 graphNodes；否则从旧版 nodes 迁移
  const migratedGraphNodes = graphNodesOf(v.graphNodes);
  const fromLegacy = migratedGraphNodes.length > 0 || v.graphNodes !== undefined ? migratedGraphNodes : legacyGraphNodesOf(v.nodes);
  const nodeIDs = new Set(fromLegacy.map((node) => node.id));
  const legacyNodes = migratedGraphNodes.length > 0 ? [] : Array.isArray(v.nodes) ? v.nodes.flatMap((x) => { const n = legacyNode(x); return n ? [n] : []; }) : [];
  return {
    id: identifier(v.id), name: text(v.name, `Canvas ${index + 1}`), viewport: viewport(v.viewport),
    nodes: legacyNodes, graphNodes: fromLegacy, edges: edgesOf(v.edges, nodeIDs),
    decorations: Array.isArray(v.decorations) ? v.decorations.flatMap((x) => { const d = decoration(x); return d ? [d] : []; }) : [],
    bookmarks: Array.isArray(v.bookmarks) ? v.bookmarks.flatMap((x) => { const b = bookmark(x); return b ? [b] : []; }) : [],
    createdAt: finite(v.createdAt, Date.now()), updatedAt: finite(v.updatedAt, Date.now()),
  };
}
function version(value: unknown): CanvasVersion | null { const v = obj(value); if (!v || !Array.isArray(v.canvases)) return null; const canvases = v.canvases.flatMap((x, i) => { const p = page(x, i); return p ? [p] : []; }); return canvases.length ? { id: identifier(v.id), name: text(v.name, "Snapshot"), createdAt: finite(v.createdAt, Date.now()), activeCanvasID: text(v.activeCanvasID, canvases[0].id), canvases } : null; }
function imageOptions(value: unknown): Record<string, ConversationOptions> { const v = obj(value); return v ? Object.fromEntries(Object.entries(v).flatMap(([k, x]) => { const o = options(x); return o ? [[k, o]] : []; })) : {}; }

export function parseCanvasState(raw: string): PersistedCanvasState | null {
  try {
    const v = obj(JSON.parse(raw)); if (!v) return null;
    const pointerMode: CanvasPointerMode = v.pointerMode === "select" ? "select" : "pan";
    let canvases = Array.isArray(v.canvases) ? v.canvases.flatMap((x, i) => { const p = page(x, i); return p ? [p] : []; }) : [];
    if (!canvases.length) {
      const legacyNodes = Array.isArray(v.nodes) ? v.nodes.flatMap((x) => { const n = legacyNode(x); return n ? [n] : []; }) : [];
      const migratedNodes = v.nodes !== undefined ? legacyGraphNodesOf(v.nodes) : graphNodesOf(v.graphNodes);
      const nodeIDs = new Set(migratedNodes.map((node) => node.id));
      canvases = [{
        id: "canvas-main", name: "Canvas 1", viewport: viewport(v.viewport),
        nodes: legacyNodes, graphNodes: migratedNodes, edges: edgesOf(v.edges, nodeIDs),
        decorations: Array.isArray(v.decorations) ? v.decorations.flatMap((x) => { const d = decoration(x); return d ? [d] : []; }) : [],
        bookmarks: [], createdAt: Date.now(), updatedAt: Date.now(),
      }];
    }
    const activeCanvasID = canvases.some((x) => x.id === v.activeCanvasID) ? text(v.activeCanvasID) : canvases[0].id;
    const active = canvases.find((x) => x.id === activeCanvasID) ?? canvases[0];
    return {
      version: 4, projectName: text(v.projectName, "Untitled project"), activeCanvasID, canvases,
      versions: Array.isArray(v.versions) ? v.versions.flatMap((x) => { const item = version(x); return item ? [item] : []; }).slice(0, 20) : [],
      conversationID: null, selectedModelName: text(v.selectedModelName) || null, pointerMode,
      viewport: active.viewport, nodes: active.nodes, graphNodes: active.graphNodes ?? [], edges: active.edges ?? [],
      decorations: active.decorations, bookmarks: active.bookmarks, imageOptions: imageOptions(v.imageOptions),
    };
  } catch { return null; }
}
export function loadCanvasState(): PersistedCanvasState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CANVAS_STORAGE_KEY) ?? localStorage.getItem(CANVAS_LEGACY_STORAGE_KEY);
    return raw ? parseCanvasState(raw) : null;
  } catch { return null; }
}
export function clearCanvasState(): void {
  if (typeof window !== "undefined") try { localStorage.removeItem(CANVAS_STORAGE_KEY); localStorage.removeItem(CANVAS_LEGACY_STORAGE_KEY); localStorage.removeItem("deeix_canvas_state_v2"); } catch {}
}
export function clampViewportScale(scale: number, min: number, max: number): number { const safeScale = Number.isFinite(scale) ? scale : 1; return Math.min(max, Math.max(min, safeScale)); }
export function zoomViewportAt(current: { x: number; y: number; scale: number }, pivot: { x: number; y: number }, nextScale: number, min = 0.2, max = 4) {
  const currentScale = clampViewportScale(current.scale, min, max);
  const scale = clampViewportScale(nextScale, min, max);
  const canvasX = (pivot.x - current.x) / currentScale;
  const canvasY = (pivot.y - current.y) / currentScale;
  return { x: pivot.x - canvasX * scale, y: pivot.y - canvasY * scale, scale };
}

// 运行时图节点构建（store 恢复时使用）
export function restoreGraphNodes(items: ReadonlyArray<PersistedGraphNode>): GraphNode[] {
  // biome-ignore lint/suspicious/useIterableCallbackReturn: switch 按 kind 穷尽所有节点类型
  return items.map((item): GraphNode => {
    const meta = { id: item.id, x: item.x, y: item.y, createdAt: item.createdAt, locked: item.locked, groupID: item.groupID ?? null, frameID: item.frameID ?? null, zIndex: item.zIndex };
    switch (item.kind) {
      case "prompt":
        return { ...meta, kind: "prompt", text: item.text } satisfies PromptGraphNode;
      case "image":
        return { ...meta, kind: "image", reference: item.reference } satisfies ImageGraphNode;
      case "generate":
        return {
          ...meta, kind: "generate", model: item.model, options: item.options ?? {},
          resultCount: item.resultCount, operation: item.operation, maskReference: item.maskReference ?? null,
          runStatus: "idle", errorMessage: item.errorMessage, errorDetail: item.errorDetail,
        } satisfies GenerateGraphNode;
      case "output":
        return {
          ...meta, kind: "output", status: item.status, fileID: item.fileID, fileName: item.fileName,
          mimeType: item.mimeType, sizeBytes: item.sizeBytes, prompt: item.prompt, model: item.model,
          sourceGenerateID: item.sourceGenerateID ?? null, errorMessage: item.errorMessage,
          errorDetail: item.errorDetail, completedAt: item.completedAt, durationMs: item.durationMs,
        } satisfies OutputGraphNode;
    }
  });
}

export function restoreEdges(items: ReadonlyArray<PersistedGraphEdge>, nodes: ReadonlyArray<GraphNode>): GraphEdge[] {
  const nodeIDs = new Set(nodes.map((node) => node.id));
  return items
    .filter((edge) => nodeIDs.has(edge.fromNodeID) && nodeIDs.has(edge.toNodeID))
    .map((edge) => ({ ...edge }));
}

export type { GraphNodeKind };
