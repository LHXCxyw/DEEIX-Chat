import type { ConversationOptions } from "@/shared/api/conversation.types";
import type { CanvasBookmark, CanvasDecoration, CanvasNode, CanvasNodeReference, CanvasPointerMode, CanvasVersion, PersistedCanvasNode, PersistedCanvasPage, PersistedCanvasState } from "./canvas-types.ts";
import { CANVAS_LEGACY_STORAGE_KEY, CANVAS_MAX_SCALE, CANVAS_MIN_SCALE, CANVAS_STORAGE_KEY } from "./canvas-types.ts";

export function toPersistedNodes(nodes: CanvasNode[]): PersistedCanvasNode[] {
  return nodes.map((node) => {
    const base = { id: node.id, x: node.x, y: node.y, prompt: node.prompt, model: node.model, createdAt: node.createdAt, parentID: node.parentID ?? null, reference: node.reference ?? node.references?.[0] ?? null, references: node.references ?? (node.reference ? [node.reference] : []), maskReference: node.maskReference ?? null, options: node.options, operation: node.operation, batchID: node.batchID, version: node.version, completedAt: node.completedAt, durationMs: node.durationMs, locked: node.locked, groupID: node.groupID ?? null, frameID: node.frameID ?? null, zIndex: node.zIndex };
    if (node.status === "done") return { ...base, status: "done", fileID: node.fileID, fileName: node.fileName, mimeType: node.mimeType, sizeBytes: node.sizeBytes };
    if (node.status === "error") return { ...base, status: "error", errorMessage: node.errorMessage, errorDetail: node.errorDetail };
    return { ...base, status: node.status };
  });
}
export function stringifyCanvasState(state: PersistedCanvasState): string { return JSON.stringify(state); }
export function saveCanvasState(state: PersistedCanvasState): void { if (typeof window !== "undefined") try { localStorage.setItem(CANVAS_STORAGE_KEY, stringifyCanvasState(state)); } catch {} }

function obj(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function finite(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function id(value: unknown): string { return text(value) || `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function viewport(value: unknown) { const v = obj(value); return { x: finite(v?.x), y: finite(v?.y), scale: clampViewportScale(finite(v?.scale, 1), CANVAS_MIN_SCALE, CANVAS_MAX_SCALE) }; }
function reference(value: unknown): CanvasNodeReference | null { const v = obj(value); return v && text(v.fileID) ? { fileID: text(v.fileID), fileName: text(v.fileName), mimeType: text(v.mimeType), sizeBytes: finite(v.sizeBytes) } : null; }
function options(value: unknown): ConversationOptions | undefined { return obj(value) as ConversationOptions | null ?? undefined; }
function node(value: unknown): PersistedCanvasNode | null {
  const v = obj(value); if (!v || !text(v.id) || !Number.isFinite(v.x) || !Number.isFinite(v.y) || typeof v.prompt !== "string" || typeof v.model !== "string") return null;
  const status = v.status === "error" ? "error" : v.status === "pending" || v.status === "streaming" ? v.status : "done";
  if (status === "done" && !text(v.fileID)) return null;
  const references = Array.isArray(v.references) ? v.references.flatMap((x) => { const item = reference(x); return item ? [item] : []; }) : [];
  const legacyReference = reference(v.reference);
  return { id: text(v.id), x: finite(v.x), y: finite(v.y), prompt: text(v.prompt), model: text(v.model), createdAt: finite(v.createdAt, Date.now()), status, parentID: text(v.parentID) || null, reference: legacyReference, references: references.length ? references : legacyReference ? [legacyReference] : [], maskReference: reference(v.maskReference), options: options(v.options), operation: v.operation === "edit" || v.operation === "inpaint" || v.operation === "outpaint" || v.operation === "crop" ? v.operation : "generate", batchID: text(v.batchID) || undefined, version: finite(v.version, 1), completedAt: finite(v.completedAt) || undefined, durationMs: finite(v.durationMs) || undefined, fileID: text(v.fileID) || undefined, fileName: text(v.fileName), mimeType: text(v.mimeType, "image/png"), sizeBytes: finite(v.sizeBytes), errorMessage: text(v.errorMessage), errorDetail: text(v.errorDetail) || undefined, locked: v.locked === true, groupID: text(v.groupID) || null, frameID: text(v.frameID) || null, zIndex: finite(v.zIndex) };
}
function decoration(value: unknown): CanvasDecoration | null { const v = obj(value); const kind = v?.kind; if (!v || (kind !== "frame" && kind !== "section" && kind !== "note")) return null; return { id: id(v.id), kind, x: finite(v.x), y: finite(v.y), width: Math.max(120, finite(v.width, 320)), height: Math.max(80, finite(v.height, 200)), title: text(v.title), text: text(v.text), color: text(v.color, "indigo"), createdAt: finite(v.createdAt, Date.now()), collapsed: v.collapsed === true, locked: v.locked === true, groupID: text(v.groupID) || null, frameID: text(v.frameID) || null, zIndex: finite(v.zIndex, kind === "note" ? 10 : -10) }; }
function bookmark(value: unknown): CanvasBookmark | null { const v = obj(value); return v ? { id: id(v.id), name: text(v.name, "Bookmark"), viewport: viewport(v.viewport), createdAt: finite(v.createdAt, Date.now()) } : null; }
function page(value: unknown, index: number): PersistedCanvasPage | null { const v = obj(value); if (!v) return null; const nodes = Array.isArray(v.nodes) ? v.nodes.flatMap((x) => { const n = node(x); return n ? [n] : []; }) : []; return { id: id(v.id), name: text(v.name, `Canvas ${index + 1}`), viewport: viewport(v.viewport), nodes, decorations: Array.isArray(v.decorations) ? v.decorations.flatMap((x) => { const d = decoration(x); return d ? [d] : []; }) : [], bookmarks: Array.isArray(v.bookmarks) ? v.bookmarks.flatMap((x) => { const b = bookmark(x); return b ? [b] : []; }) : [], createdAt: finite(v.createdAt, Date.now()), updatedAt: finite(v.updatedAt, Date.now()) }; }
function version(value: unknown): CanvasVersion | null { const v = obj(value); if (!v || !Array.isArray(v.canvases)) return null; const canvases = v.canvases.flatMap((x, i) => { const p = page(x, i); return p ? [p] : []; }); return canvases.length ? { id: id(v.id), name: text(v.name, "Snapshot"), createdAt: finite(v.createdAt, Date.now()), activeCanvasID: text(v.activeCanvasID, canvases[0].id), canvases } : null; }
function imageOptions(value: unknown): Record<string, ConversationOptions> { const v = obj(value); return v ? Object.fromEntries(Object.entries(v).flatMap(([k, x]) => { const o = options(x); return o ? [[k, o]] : []; })) : {}; }

export function parseCanvasState(raw: string): PersistedCanvasState | null {
  try {
    const v = obj(JSON.parse(raw)); if (!v) return null;
    const pointerMode: CanvasPointerMode = v.pointerMode === "select" ? "select" : "pan";
    const legacyNodes = Array.isArray(v.nodes) ? v.nodes.flatMap((x) => { const n = node(x); return n ? [n] : []; }) : [];
    let canvases = Array.isArray(v.canvases) ? v.canvases.flatMap((x, i) => { const p = page(x, i); return p ? [p] : []; }) : [];
    if (!canvases.length) canvases = [{ id: "canvas-main", name: "Canvas 1", viewport: viewport(v.viewport), nodes: legacyNodes, decorations: Array.isArray(v.decorations) ? v.decorations.flatMap((x) => { const d = decoration(x); return d ? [d] : []; }) : [], bookmarks: [], createdAt: Date.now(), updatedAt: Date.now() }];
    const activeCanvasID = canvases.some((x) => x.id === v.activeCanvasID) ? text(v.activeCanvasID) : canvases[0].id;
    const active = canvases.find((x) => x.id === activeCanvasID) ?? canvases[0];
    return { version: 3, projectName: text(v.projectName, "Untitled project"), activeCanvasID, canvases, versions: Array.isArray(v.versions) ? v.versions.flatMap((x) => { const item = version(x); return item ? [item] : []; }).slice(0, 20) : [], conversationID: null, selectedModelName: text(v.selectedModelName) || null, pointerMode, viewport: active.viewport, nodes: active.nodes, decorations: active.decorations, bookmarks: active.bookmarks, imageOptions: imageOptions(v.imageOptions) };
  } catch { return null; }
}
export function loadCanvasState(): PersistedCanvasState | null { if (typeof window === "undefined") return null; try { const raw = localStorage.getItem(CANVAS_STORAGE_KEY) ?? localStorage.getItem(CANVAS_LEGACY_STORAGE_KEY); return raw ? parseCanvasState(raw) : null; } catch { return null; } }
export function clearCanvasState(): void { if (typeof window !== "undefined") try { localStorage.removeItem(CANVAS_STORAGE_KEY); localStorage.removeItem(CANVAS_LEGACY_STORAGE_KEY); } catch {} }
export function clampViewportScale(scale: number, min: number, max: number): number { const safeScale = Number.isFinite(scale) ? scale : 1; return Math.min(max, Math.max(min, safeScale)); }
export function zoomViewportAt(current: { x: number; y: number; scale: number }, pivot: { x: number; y: number }, nextScale: number, min = 0.2, max = 4) {
  const currentScale = clampViewportScale(current.scale, min, max);
  const scale = clampViewportScale(nextScale, min, max);
  const canvasX = (pivot.x - current.x) / currentScale;
  const canvasY = (pivot.y - current.y) / currentScale;
  return { x: pivot.x - canvasX * scale, y: pivot.y - canvasY * scale, scale };
}
