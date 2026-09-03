import assert from "node:assert/strict";
import test from "node:test";

import { activeElasticDecorationForElement, arrangeCanvasElements, canvasElementIDsCarriedByDecoration, canvasElementIDsCarriedByFrame, canvasElementIDsInRegion, elasticCanvasBounds, isCanvasElementCenterInside, isCanvasElementInside, nextCanvasVersion, selectedNodeIDsForFilter, shouldDetachElasticBoundary, stableFrameIDForElement, trappedFocusIndex, viewportForCanvasKey } from "./canvas-interactions.ts";
import { clampViewportScale, parseCanvasState, stringifyCanvasState, toPersistedNodes, zoomViewportAt } from "./canvas-persist.ts";
import { CANVAS_MAX_SCALE, CANVAS_MIN_SCALE } from "./canvas-types.ts";

test("将 v2 单画布状态迁移为 v3 项目 schema", () => {
  const restored = parseCanvasState(JSON.stringify({
    selectedModelName: "image-model",
    pointerMode: "select",
    viewport: { x: 12, y: -8, scale: 2 },
    nodes: [{
      id: "node-1",
      x: 24,
      y: 32,
      prompt: "测试图像",
      model: "image-model",
      createdAt: 1,
      status: "done",
      fileID: "file-1",
    }],
    imageOptions: {},
  }));

  assert.equal(restored?.version, 3);
  assert.equal(restored?.canvases?.length, 1);
  assert.equal(restored?.activeCanvasID, "canvas-main");
  assert.equal(restored?.nodes[0]?.id, "node-1");
  assert.equal(restored?.canvases?.[0]?.nodes[0]?.id, "node-1");
});

test("迁移时过滤非法节点并钳制视口缩放", () => {
  const restored = parseCanvasState(JSON.stringify({
    viewport: { x: 0, y: 0, scale: 999 },
    nodes: [
      { id: "bad", x: null, y: 0, prompt: "bad", model: "model", status: "done", fileID: "file" },
      { id: "ok", x: 0, y: 0, prompt: "ok", model: "model", status: "done", fileID: "file" },
    ],
  }));

  assert.equal(restored?.viewport.scale, CANVAS_MAX_SCALE);
  assert.deepEqual(restored?.nodes.map((node) => node.id), ["ok"]);
});

test("缩放校验处理边界和非有限输入", () => {
  assert.equal(clampViewportScale(0.01, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE), CANVAS_MIN_SCALE);
  assert.equal(clampViewportScale(10, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE), CANVAS_MAX_SCALE);
  assert.equal(clampViewportScale(Number.NaN, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE), 1);
});

test("锚点缩放保持锚点下的画布坐标不变", () => {
  const current = { x: 20, y: -10, scale: 2 };
  const pivot = { x: 220, y: 190 };
  const next = zoomViewportAt(current, pivot, 4);

  assert.equal((pivot.x - current.x) / current.scale, (pivot.x - next.x) / next.scale);
  assert.equal((pivot.y - current.y) / current.scale, (pivot.y - next.y) / next.scale);
});

test("画布键盘缩放以视口中心为锚点并支持重置", () => {
  const viewport = { x: 10, y: 20, scale: 1 };
  assert.deepEqual(viewportForCanvasKey("0", viewport, { width: 800, height: 600 }), { x: 0, y: 0, scale: 1 });
  assert.equal(viewportForCanvasKey("x", viewport, { width: 800, height: 600 }), null);
  assert.equal(viewportForCanvasKey("+", viewport, { width: 800, height: 600 })?.scale, 1.25);
  assert.equal(viewportForCanvasKey("-", { ...viewport, scale: CANVAS_MIN_SCALE }, { width: 800, height: 600 })?.scale, CANVAS_MIN_SCALE);
});

test("同批多结果共享版本，派生节点按关系链最大版本递增", () => {
  const parent = { id: "root", batchID: "root", version: 1 };
  assert.equal(nextCanvasVersion([], undefined), 1);
  assert.equal(nextCanvasVersion([
    parent,
    { batchID: "root", version: 2 },
    { batchID: "root", version: 4 },
    { batchID: "other", version: 9 },
  ], parent), 5);
});

test("状态筛选会剔除不可见节点选择", () => {
  const nodes = [{ id: "done", status: "done" }, { id: "error", status: "error" }];
  assert.deepEqual(selectedNodeIDsForFilter(["done", "error"], nodes, "done"), ["done"]);
  assert.deepEqual(selectedNodeIDsForFilter(["done", "error"], nodes, "all"), ["done", "error"]);
});

test("Frame 仅承载完整位于边界内的元素", () => {
  const frame = { x: 100, y: 100, width: 480, height: 360 };

  assert.equal(isCanvasElementInside(frame, { x: 120, y: 120, width: 288, height: 220 }), true);
  assert.equal(isCanvasElementInside(frame, { x: 100, y: 100, width: 480, height: 360 }), true);
  assert.equal(isCanvasElementInside(frame, { x: 80, y: 120, width: 288, height: 220 }), false);
  assert.equal(isCanvasElementInside(frame, { x: 320, y: 260, width: 288, height: 220 }), false);
});

test("Frame 按元素中心点承载，Section 仅分区不承载", () => {
  const elements = [
    { id: "inside", x: 120, y: 120, width: 100, height: 100 },
    { id: "center-inside", x: 40, y: 120, width: 160, height: 100 },
    { id: "outside", x: 520, y: 420, width: 100, height: 100 },
  ];
  const bounds = { id: "container", x: 100, y: 100, width: 480, height: 360 };

  assert.equal(isCanvasElementCenterInside(bounds, elements[1]), true);
  assert.deepEqual([...canvasElementIDsCarriedByDecoration({ ...bounds, kind: "frame" }, elements)], ["inside", "center-inside"]);
  assert.deepEqual([...canvasElementIDsCarriedByDecoration({ ...bounds, kind: "section" }, elements)], []);
  assert.deepEqual([...canvasElementIDsInRegion(bounds, elements)], ["inside", "center-inside"]);
});

test("卡片从外部进入时动态激活面积最小的 Frame 或 Section", () => {
  const decorations = [
    { id: "section", kind: "section" as const, x: 0, y: 0, width: 500, height: 500 },
    { id: "frame", kind: "frame" as const, x: 100, y: 100, width: 200, height: 200 },
    { id: "locked", kind: "frame" as const, x: 120, y: 120, width: 100, height: 100, locked: true },
  ];
  assert.equal(activeElasticDecorationForElement({ id: "node", x: 130, y: 130, width: 40, height: 40 }, decorations)?.id, "frame");
  assert.equal(activeElasticDecorationForElement({ id: "node", x: 600, y: 600, width: 40, height: 40 }, decorations), null);
});

test("移动 Frame 只携带原 frameID 成员，不吸附新进入的元素", () => {
  assert.deepEqual([...canvasElementIDsCarriedByFrame("frame", [
    { id: "original", x: 500, y: 500, width: 100, height: 100, frameID: "frame" },
    { id: "new", x: 120, y: 120, width: 100, height: 100 },
  ])], ["original"]);
});

test("重叠 Frame 优先保持已有归属，否则稳定选择面积更小者", () => {
  const frames = [
    { id: "large", x: 0, y: 0, width: 500, height: 500 },
    { id: "small", x: 100, y: 100, width: 200, height: 200 },
  ];
  const element = { id: "node", x: 140, y: 140, width: 100, height: 100 };

  assert.equal(stableFrameIDForElement(element, frames), "small");
  assert.equal(stableFrameIDForElement({ ...element, frameID: "large" }, frames), "large");
  assert.equal(stableFrameIDForElement({ ...element, x: 600, frameID: "large" }, frames), null);
});

test("折叠 Frame 粘滞保留原成员且不接收新成员", () => {
  const frames = [
    { id: "open", x: 0, y: 0, width: 200, height: 200 },
    { id: "folded", x: 0, y: 0, width: 200, height: 200, collapsed: true },
  ];
  const element = { id: "node", x: 50, y: 50, width: 100, height: 100 };

  // 已属于折叠 Frame 的成员即使不在可视标题条内也保持归属，展开时原位还原
  assert.equal(stableFrameIDForElement({ ...element, x: 500, frameID: "folded" }, frames), "folded");
  // 新元素不会被折叠 Frame 承载
  assert.equal(stableFrameIDForElement(element, frames), "open");
});

test("弹性边界按全部内容最小包围盒与内边距双向收缩扩张", () => {
  const container = { x: 100, y: 100, width: 480, height: 360 };
  assert.deepEqual(elasticCanvasBounds(container, [
    { x: 140, y: 140, width: 100, height: 100 },
    { x: 320, y: 220, width: 120, height: 80 },
  ], 240), {
    x: 116,
    y: 116,
    width: 348,
    height: 208,
    requestedExpansion: 0,
    appliedExpansion: 0,
    tension: 0,
    exhausted: false,
  });

  const expanded = elasticCanvasBounds(container, [
    { x: 40, y: 420, width: 100, height: 100 },
    { x: 240, y: 180, width: 100, height: 100 },
  ], 240, 20);
  assert.equal(expanded.x, 20);
  assert.equal(expanded.y, 160);
  assert.equal(expanded.width, 340);
  assert.equal(expanded.height, 380);
  assert.equal(expanded.appliedExpansion, 160);
  assert.equal(expanded.tension, 2 / 3);
});

test("弹性边界按总扩张预算分配并标记耗尽", () => {
  const expanded = elasticCanvasBounds(
    { x: 100, y: 100, width: 200, height: 200 },
    [{ x: -100, y: -100, width: 500, height: 500 }],
    120,
    0,
  );
  assert.equal(expanded.requestedExpansion, 600);
  assert.equal(expanded.appliedExpansion, 120);
  assert.equal(expanded.x, 60);
  assert.equal(expanded.y, 60);
  assert.equal(expanded.width, 260);
  assert.equal(expanded.height, 260);
  assert.equal(expanded.exhausted, true);
});

test("弹性边界无剩余内容时保持容器不变", () => {
  const container = { x: 100, y: 100, width: 200, height: 200 };
  assert.deepEqual(elasticCanvasBounds(container, [], 120), {
    ...container,
    requestedExpansion: 0,
    appliedExpansion: 0,
    tension: 0,
    exhausted: false,
  });
});

test("弹性响应至少覆盖卡片对角尺度阈值", () => {
  const diagonal = Math.hypot(288, 340);
  assert.equal(shouldDetachElasticBoundary({
    overflowDistance: diagonal - 0.1,
    velocity: 0,
    requestedExpansion: 1,
    expansionBudget: diagonal,
    distanceThreshold: diagonal,
  }), false);
  assert.equal(shouldDetachElasticBoundary({
    overflowDistance: diagonal,
    velocity: 0,
    requestedExpansion: 1,
    expansionBudget: diagonal,
    distanceThreshold: diagonal,
  }), true);
});

test("弹性响应可按拖拽距离、速度或预算脱离且边界内不脱离", () => {
  const base = { overflowDistance: 32, velocity: 0.4, requestedExpansion: 80, expansionBudget: 240 };
  assert.equal(shouldDetachElasticBoundary(base), false);
  assert.equal(shouldDetachElasticBoundary({ ...base, overflowDistance: 168 }), true);
  assert.equal(shouldDetachElasticBoundary({ ...base, velocity: 1.35 }), true);
  assert.equal(shouldDetachElasticBoundary({ ...base, requestedExpansion: 241 }), true);
  assert.equal(shouldDetachElasticBoundary({ ...base, overflowDistance: 0, velocity: 9, requestedExpansion: 999 }), false);
});

test("Frame 归属与 Section 折叠状态可持久化恢复", () => {
  const restored = parseCanvasState(JSON.stringify({
    viewport: { x: 0, y: 0, scale: 1 }, pointerMode: "pan", imageOptions: {},
    nodes: [{ id: "node", x: 0, y: 0, prompt: "p", model: "m", status: "done", fileID: "f", frameID: "frame" }],
    decorations: [{ id: "frame", kind: "frame", x: 0, y: 0, width: 400, height: 400 }, { id: "section", kind: "section", x: 0, y: 0, width: 400, height: 400, collapsed: true }],
  }));

  assert.equal(restored?.nodes[0]?.frameID, "frame");
  assert.equal(restored?.decorations?.find((item) => item.id === "section")?.collapsed, true);
});

test("节点 frameID 在保存与解析往返中不丢失（折叠 Frame 成员重载后仍隐藏）", () => {
  const node = {
    id: "node-1", x: 10, y: 20, prompt: "测试", model: "image-model", createdAt: 1,
    status: "done" as const, fileID: "file-1", frameID: "frame-1",
  };
  const roundTripped = parseCanvasState(stringifyCanvasState({
    version: 3, projectName: "p", activeCanvasID: "c", canvases: [], versions: [], conversationID: null,
    selectedModelName: null, pointerMode: "pan" as const,
    viewport: { x: 0, y: 0, scale: 1 }, nodes: toPersistedNodes([node]), decorations: [], bookmarks: [], imageOptions: {},
  }));

  assert.equal(roundTripped?.nodes[0]?.frameID, "frame-1");
});

test("混合图片与装饰按实际宽度水平分布", () => {
  const patches = arrangeCanvasElements([
    { id: "image", x: 0, y: 10, width: 320, height: 420 },
    { id: "note", x: 400, y: 20, width: 200, height: 140 },
    { id: "frame", x: 800, y: 30, width: 480, height: 320 },
  ], new Set(["image", "note", "frame"]), "horizontal");

  assert.equal(patches?.get("image")?.x, 0);
  assert.equal(patches?.get("note")?.x, 460);
  assert.equal(patches?.get("frame")?.x, 800);
});

test("水平分布跳过锁定元素且不足两个可移动元素时失败", () => {
  const elements = [
    { id: "left", x: 0, y: 0, width: 100, height: 100 },
    { id: "locked", x: 200, y: 0, width: 100, height: 100, locked: true },
    { id: "right", x: 500, y: 0, width: 100, height: 100 },
  ];
  const patches = arrangeCanvasElements(elements, new Set(elements.map((item) => item.id)), "horizontal");

  assert.equal(patches?.has("locked"), false);
  assert.equal(patches?.get("left")?.x, 0);
  assert.equal(patches?.get("right")?.x, 500);
  assert.equal(arrangeCanvasElements(elements, new Set(["left", "locked"]), "horizontal"), null);
});

test("图片和装饰可共同置顶且无可操作元素时不报告成功", () => {
  const elements = [
    { id: "image", x: 0, y: 0, width: 320, height: 420, zIndex: 2 },
    { id: "note", x: 0, y: 0, width: 200, height: 140, zIndex: 10 },
  ];
  const patches = arrangeCanvasElements(elements, new Set(["image", "note"]), "front");

  assert.equal(patches?.get("image")?.zIndex, 11);
  assert.equal(patches?.get("note")?.zIndex, 11);
  assert.equal(arrangeCanvasElements(elements, new Set(), "front"), null);
  assert.equal(arrangeCanvasElements([{ ...elements[0], locked: true }], new Set(["image"]), "front"), null);
});

test("灯箱焦点环在首尾元素间循环", () => {
  assert.equal(trappedFocusIndex(0, 2, true), 1);
  assert.equal(trappedFocusIndex(1, 2, false), 0);
  assert.equal(trappedFocusIndex(0, 2, false), 0);
  assert.equal(trappedFocusIndex(-1, 0, false), null);
});
