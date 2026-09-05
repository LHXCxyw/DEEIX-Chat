import { zoomViewportAt } from "./canvas-persist.ts";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  type CanvasDecoration,
  type CanvasViewport,
} from "./canvas-types.ts";

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

// ---------------------------------------------------------------------------
// Frame 自动回弹 / 扩展：Frame 承载的成员发生增减时，边界随内容自动调整
// ---------------------------------------------------------------------------
export type FrameRefitElement = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  frameID?: string | null;
};

// 成员包围盒 + 内边距（顶部预留标题栏），用于成员减少后的收缩回弹
export function frameFitBounds(
  members: ReadonlyArray<FrameRefitElement>,
  padding = 24,
  topPadding = padding,
): ElasticCanvasBounds {
  const minX = Math.min(...members.map((item) => item.x)) - padding;
  const minY = Math.min(...members.map((item) => item.y)) - topPadding;
  const maxX = Math.max(...members.map((item) => item.x + item.width)) + padding;
  const maxY = Math.max(...members.map((item) => item.y + item.height)) + padding;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// 在 Frame 当前边界基础上仅向外扩展以包住成员（不收缩已有边界），用于成员增加
export function frameUnionBounds(
  frame: ElasticCanvasBounds,
  members: ReadonlyArray<FrameRefitElement>,
  padding = 24,
  topPadding = padding,
): ElasticCanvasBounds {
  let { x, y, width, height } = frame;
  let right = x + width;
  let bottom = y + height;
  for (const member of members) {
    x = Math.min(x, member.x - padding);
    y = Math.min(y, member.y - topPadding);
    right = Math.max(right, member.x + member.width + padding);
    bottom = Math.max(bottom, member.y + member.height + padding);
  }
  return { x, y, width: right - x, height: bottom - y };
}

// 成员增减后重算 Frame 边界：仅调整承载成员发生变化且未锁定/未折叠的 Frame。
// 成员增加时只向外扩展；成员减少时收缩回剩余内容包围盒；成员清空时回弹到最小尺寸。
export function refitFrameDecorations<T extends CanvasDecoration>(
  prevElements: ReadonlyArray<FrameRefitElement>,
  nextElements: ReadonlyArray<FrameRefitElement>,
  decorations: ReadonlyArray<T>,
  padding = 24,
  topPadding = padding,
): T[] {
  const frameIDs = new Set(decorations.filter((item) => item.kind === "frame").map((item) => item.id));
  if (frameIDs.size === 0) {
    return [...decorations];
  }
  const membership = (elements: ReadonlyArray<FrameRefitElement>) => {
    const map = new Map<string, Set<string>>();
    for (const element of elements) {
      if (element.frameID && frameIDs.has(element.frameID) && !frameIDs.has(element.id)) {
        const members = map.get(element.frameID);
        if (members) {
          members.add(element.id);
        } else {
          map.set(element.frameID, new Set([element.id]));
        }
      }
    }
    return map;
  };
  const prevMembership = membership(prevElements);
  const nextMembership = membership(nextElements);
  return decorations.map((decoration) => {
    if (decoration.kind !== "frame" || decoration.locked || decoration.collapsed) {
      return decoration;
    }
    const before = prevMembership.get(decoration.id) ?? new Set<string>();
    const after = nextMembership.get(decoration.id) ?? new Set<string>();
    const unchanged = before.size === after.size && [...after].every((id) => before.has(id));
    if (unchanged) {
      return decoration;
    }
    const members = nextElements.filter((element) => after.has(element.id));
    if (members.length === 0) {
      // 成员清空：回弹到最小尺寸，锚定原位置
      return {
        ...decoration,
        width: Math.min(decoration.width, FRAME_REFIT_MIN_SIZE.width),
        height: Math.min(decoration.height, FRAME_REFIT_MIN_SIZE.height),
      };
    }
    if (after.size > before.size) {
      // 成员增加：向外扩展以容纳新成员
      return { ...decoration, ...frameUnionBounds(decoration, members, padding, topPadding) };
    }
    // 成员减少：收缩回剩余内容的最小包围盒
    const fitted = frameFitBounds(members, padding, topPadding);
    return {
      ...decoration,
      x: fitted.x,
      y: fitted.y,
      width: Math.max(FRAME_REFIT_MIN_SIZE.width, fitted.width),
      height: Math.max(FRAME_REFIT_MIN_SIZE.height, fitted.height),
    };
  });
}

export const FRAME_REFIT_MIN_SIZE = { width: 160, height: 120 };

export type ElasticCanvasBounds = Pick<CanvasArrangeElement, "x" | "y" | "width" | "height">;

// 橡皮筋响应曲线：边缘 1:1 跟随内容超出距离（与节点移动距离一致），
// 达到 maxStretch 上限后停住不再扩展。只取决于该侧的超出距离，
// 与 Frame 当前尺寸、其他侧超出量和视口位置无关，弹性手感始终一致
function elasticFollow(distance: number, maxStretch: number): number {
  const limit = Math.max(0, maxStretch);
  if (limit === 0 || distance <= 0) {
    return 0;
  }
  return Math.min(distance, limit);
}

export function elasticCanvasBounds(
  container: ElasticCanvasBounds,
  content: ElasticCanvasBounds | ReadonlyArray<ElasticCanvasBounds>,
  maxStretch: number,
  padding = 24,
  topPadding = padding,
): ElasticCanvasBounds & { requestedExpansion: number; appliedExpansion: number; tension: number } {
  const contents = Array.isArray(content) ? content : [content];
  if (contents.length === 0) {
    return { ...container, requestedExpansion: 0, appliedExpansion: 0, tension: 0 };
  }
  const contentLeft = Math.min(...contents.map((item) => item.x)) - padding;
  const contentTop = Math.min(...contents.map((item) => item.y)) - topPadding;
  const contentRight = Math.max(...contents.map((item) => item.x + item.width)) + padding;
  const contentBottom = Math.max(...contents.map((item) => item.y + item.height)) + padding;
  // 各侧需要的扩展距离（内容包围盒超出容器的部分）
  const left = Math.max(0, container.x - contentLeft);
  const top = Math.max(0, container.y - contentTop);
  const right = Math.max(0, contentRight - (container.x + container.width));
  const bottom = Math.max(0, contentBottom - (container.y + container.height));
  const requestedExpansion = left + top + right + bottom;
  const stretchLeft = elasticFollow(left, maxStretch);
  const stretchTop = elasticFollow(top, maxStretch);
  const stretchRight = elasticFollow(right, maxStretch);
  const stretchBottom = elasticFollow(bottom, maxStretch);
  const appliedExpansion = stretchLeft + stretchTop + stretchRight + stretchBottom;
  const limit = Math.max(0, maxStretch);
  const targetLeft = contentLeft < container.x ? container.x - stretchLeft : contentLeft;
  const targetTop = contentTop < container.y ? container.y - stretchTop : contentTop;
  const targetRight = contentRight > container.x + container.width
    ? container.x + container.width + stretchRight
    : contentRight;
  const targetBottom = contentBottom > container.y + container.height
    ? container.y + container.height + stretchBottom
    : contentBottom;

  return {
    x: targetLeft,
    y: targetTop,
    width: Math.max(0, targetRight - targetLeft),
    height: Math.max(0, targetBottom - targetTop),
    requestedExpansion,
    appliedExpansion,
    tension: limit === 0 ? (requestedExpansion > 0 ? 1 : 0) : Math.min(1, appliedExpansion / limit),
  };
}

// 仅刻意甩出（瞬时速度达标）才触发脱离：橡皮筋拉伸到上限后节点仍然挂在 Frame 上，
// 松手时若中心已在外则按成员变化自动回弹，避免"离边缘越近越容易脱离"的距离依赖。
export function shouldDetachElasticBoundary({
  velocity,
  velocityThreshold = 3,
}: {
  velocity: number;
  velocityThreshold?: number;
}): boolean {
  return velocity >= velocityThreshold;
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
