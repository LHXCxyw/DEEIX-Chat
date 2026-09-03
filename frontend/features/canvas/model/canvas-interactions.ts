import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasViewport,
} from "./canvas-types.ts";
import { zoomViewportAt } from "./canvas-persist.ts";

export function viewportForCanvasKey(
  key: string,
  viewport: CanvasViewport,
  size: { width: number; height: number },
): CanvasViewport | null {
  if (key === "0") {
    return { x: 0, y: 0, scale: 1 };
  }
  const zoomIn = key === "+" || key === "=";
  const zoomOut = key === "-" || key === "_";
  if (!zoomIn && !zoomOut) {
    return null;
  }
  return zoomViewportAt(
    viewport,
    { x: size.width / 2, y: size.height / 2 },
    zoomIn ? viewport.scale * 1.25 : viewport.scale / 1.25,
    CANVAS_MIN_SCALE,
    CANVAS_MAX_SCALE,
  );
}

export function nextCanvasVersion(
  nodes: ReadonlyArray<{ batchID?: string; version?: number }>,
  parent: { id: string; batchID?: string; version?: number } | undefined,
): number {
  if (!parent) {
    return 1;
  }
  const batchID = parent.batchID ?? parent.id;
  return Math.max(
    parent.version ?? 1,
    ...nodes.filter((node) => node.batchID === batchID).map((node) => node.version ?? 1),
  ) + 1;
}

export function selectedNodeIDsForFilter(
  selectedNodeIDs: string[],
  nodes: ReadonlyArray<{ id: string; status: string }>,
  filter: string,
): string[] {
  if (filter === "all") {
    return selectedNodeIDs;
  }
  const visible = new Set(nodes.filter((node) => node.status === filter).map((node) => node.id));
  return selectedNodeIDs.filter((id) => visible.has(id));
}

export type CanvasArrangeAction = "left" | "center" | "right" | "top" | "middle" | "bottom" | "horizontal" | "vertical" | "front" | "back";

type CanvasArrangeElement = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  locked?: boolean;
};

export function isCanvasElementInside(
  container: Pick<CanvasArrangeElement, "x" | "y" | "width" | "height">,
  element: Pick<CanvasArrangeElement, "x" | "y" | "width" | "height">,
): boolean {
  return element.x >= container.x &&
    element.y >= container.y &&
    element.x + element.width <= container.x + container.width &&
    element.y + element.height <= container.y + container.height;
}

export function isCanvasElementCenterInside(
  container: Pick<CanvasArrangeElement, "x" | "y" | "width" | "height">,
  element: Pick<CanvasArrangeElement, "x" | "y" | "width" | "height">,
): boolean {
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  return centerX >= container.x && centerX <= container.x + container.width &&
    centerY >= container.y && centerY <= container.y + container.height;
}

export function canvasElementIDsInRegion(
  region: Pick<CanvasArrangeElement, "id" | "x" | "y" | "width" | "height">,
  elements: ReadonlyArray<CanvasArrangeElement>,
): Set<string> {
  return new Set(elements
    .filter((element) => element.id !== region.id && isCanvasElementCenterInside(region, element))
    .map((element) => element.id));
}

export function stableFrameIDForElement(
  element: CanvasArrangeElement & { frameID?: string | null },
  frames: ReadonlyArray<CanvasArrangeElement & { collapsed?: boolean }>,
): string | null {
  // 折叠的 Frame 保留原有成员归属（成员被收纳隐藏，展开时原位还原）
  if (element.frameID && frames.some((frame) => frame.id === element.frameID && frame.collapsed)) {
    return element.frameID;
  }
  // 折叠的 Frame 不接收新成员（视觉上只剩标题条）
  const matches = frames
    .filter((frame) => frame.id !== element.id && !frame.collapsed)
    .filter((frame) => isCanvasElementCenterInside(frame, element));
  if (element.frameID && matches.some((frame) => frame.id === element.frameID)) return element.frameID;
  return [...matches].sort((a, b) => a.width * a.height - b.width * b.height || a.id.localeCompare(b.id))[0]?.id ?? null;
}

export function activeElasticDecorationForElement<T extends CanvasArrangeElement & { kind: "frame" | "section" | "note"; collapsed?: boolean }>(
  element: CanvasArrangeElement,
  decorations: ReadonlyArray<T>,
): T | null {
  return decorations
    .filter((item) => (item.kind === "frame" || item.kind === "section") && !item.locked && !item.collapsed)
    .filter((item) => isCanvasElementCenterInside(item, element))
    .sort((a, b) => a.width * a.height - b.width * b.height || a.id.localeCompare(b.id))[0] ?? null;
}

export function canvasElementIDsCarriedByDecoration(
  decoration: CanvasArrangeElement & { kind: "frame" | "section" | "note" },
  elements: ReadonlyArray<CanvasArrangeElement>,
): Set<string> {
  if (decoration.kind !== "frame") return new Set();
  return new Set(elements
    .filter((element) => element.id !== decoration.id && isCanvasElementCenterInside(decoration, element))
    .map((element) => element.id));
}

export function canvasElementIDsCarriedByFrame(
  frameID: string,
  elements: ReadonlyArray<CanvasArrangeElement & { frameID?: string | null }>,
): Set<string> {
  return new Set(elements.filter((element) => element.frameID === frameID).map((element) => element.id));
}

export type ElasticCanvasBounds = Pick<CanvasArrangeElement, "x" | "y" | "width" | "height">;

export function elasticCanvasBounds(
  container: ElasticCanvasBounds,
  content: ElasticCanvasBounds | ReadonlyArray<ElasticCanvasBounds>,
  expansionBudget: number,
  padding = 24,
  topPadding = padding,
): ElasticCanvasBounds & { requestedExpansion: number; appliedExpansion: number; tension: number; exhausted: boolean } {
  const contents = Array.isArray(content) ? content : [content];
  if (contents.length === 0) {
    return { ...container, requestedExpansion: 0, appliedExpansion: 0, tension: 0, exhausted: false };
  }
  const contentLeft = Math.min(...contents.map((item) => item.x)) - padding;
  const contentTop = Math.min(...contents.map((item) => item.y)) - topPadding;
  const contentRight = Math.max(...contents.map((item) => item.x + item.width)) + padding;
  const contentBottom = Math.max(...contents.map((item) => item.y + item.height)) + padding;
  const left = Math.max(0, container.x - contentLeft);
  const top = Math.max(0, container.y - contentTop);
  const right = Math.max(0, contentRight - (container.x + container.width));
  const bottom = Math.max(0, contentBottom - (container.y + container.height));
  const requestedExpansion = left + top + right + bottom;
  const budget = Math.max(0, expansionBudget);
  const ratio = requestedExpansion === 0 ? 1 : Math.min(1, budget / requestedExpansion);
  const targetLeft = contentLeft < container.x ? container.x - left * ratio : contentLeft;
  const targetTop = contentTop < container.y ? container.y - top * ratio : contentTop;
  const targetRight = contentRight > container.x + container.width
    ? container.x + container.width + right * ratio
    : contentRight;
  const targetBottom = contentBottom > container.y + container.height
    ? container.y + container.height + bottom * ratio
    : contentBottom;
  const appliedExpansion = requestedExpansion * ratio;

  return {
    x: targetLeft,
    y: targetTop,
    width: Math.max(0, targetRight - targetLeft),
    height: Math.max(0, targetBottom - targetTop),
    requestedExpansion,
    appliedExpansion,
    tension: budget === 0 ? (requestedExpansion > 0 ? 1 : 0) : Math.min(1, requestedExpansion / budget),
    exhausted: requestedExpansion > budget,
  };
}

export function shouldDetachElasticBoundary({
  overflowDistance,
  velocity,
  requestedExpansion,
  expansionBudget,
  distanceThreshold = 168,
  velocityThreshold = 1.35,
}: {
  overflowDistance: number;
  velocity: number;
  requestedExpansion: number;
  expansionBudget: number;
  distanceThreshold?: number;
  velocityThreshold?: number;
}): boolean {
  if (overflowDistance <= 0) return false;
  return overflowDistance >= distanceThreshold || velocity >= velocityThreshold || requestedExpansion > expansionBudget;
}

export function arrangeCanvasElements(
  elements: ReadonlyArray<CanvasArrangeElement>,
  selectedIDs: ReadonlySet<string>,
  action: CanvasArrangeAction,
): Map<string, Partial<Pick<CanvasArrangeElement, "x" | "y" | "zIndex">>> | null {
  const selected = elements.filter((item) => selectedIDs.has(item.id) && !item.locked);
  if (selected.length === 0 || (!(action === "front" || action === "back") && selected.length < 2)) {
    return null;
  }
  if (action === "front" || action === "back") {
    const edge = action === "front"
      ? Math.max(0, ...elements.map((item) => item.zIndex ?? 0)) + 1
      : Math.min(0, ...elements.map((item) => item.zIndex ?? 0)) - 1;
    return new Map(selected.map((item) => [item.id, { zIndex: edge }]));
  }

  const left = Math.min(...selected.map((item) => item.x));
  const right = Math.max(...selected.map((item) => item.x + item.width));
  const top = Math.min(...selected.map((item) => item.y));
  const bottom = Math.max(...selected.map((item) => item.y + item.height));
  const ordered = [...selected].sort((a, b) => action === "vertical" ? a.y - b.y : a.x - b.x);
  const totalSize = ordered.reduce((sum, item) => sum + (action === "vertical" ? item.height : item.width), 0);
  const gap = ((action === "vertical" ? bottom - top : right - left) - totalSize) / (ordered.length - 1);
  let cursor = action === "vertical" ? top : left;
  const distributedPosition = new Map(ordered.map((item) => {
    const position = cursor;
    cursor += (action === "vertical" ? item.height : item.width) + gap;
    return [item.id, position];
  }));

  return new Map(selected.map((item) => [item.id, {
    x: action === "left" ? left
      : action === "center" ? (left + right - item.width) / 2
        : action === "right" ? right - item.width
          : action === "horizontal" ? distributedPosition.get(item.id)
            : item.x,
    y: action === "top" ? top
      : action === "middle" ? (top + bottom - item.height) / 2
        : action === "bottom" ? bottom - item.height
          : action === "vertical" ? distributedPosition.get(item.id)
            : item.y,
  }]));
}

export function trappedFocusIndex(
  currentIndex: number,
  itemCount: number,
  backwards: boolean,
): number | null {
  if (itemCount === 0) {
    return null;
  }
  if (backwards && currentIndex <= 0) {
    return itemCount - 1;
  }
  if (!backwards && currentIndex >= itemCount - 1) {
    return 0;
  }
  return currentIndex;
}
