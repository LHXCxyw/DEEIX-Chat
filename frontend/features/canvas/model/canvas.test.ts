import assert from "node:assert/strict";
import test from "node:test";

import { activeElasticDecorationForElement, arrangeCanvasElements, canvasElementIDsCarriedByDecoration, canvasElementIDsCarriedByFrame, canvasElementIDsInRegion, elasticCanvasBounds, frameFitBounds, frameUnionBounds, isCanvasElementCenterInside, isCanvasElementInside, nextCanvasVersion, refitFrameDecorations, selectedNodeIDsForFilter, shouldDetachElasticBoundary, stableFrameIDForElement, trappedFocusIndex, viewportForCanvasKey } from "./canvas-interactions.ts";
import { canConnectGraphNodes, createUserPromptTemplate, gatherGraphGenerateInputs, graphEdgeMidpoint, graphEdgePath, graphNodePorts, graphPortCanvasPosition, isGraphPortCompatibleTarget, isPromptGraphNode, loadPromptTemplates, promptNodeTruncated } from "./canvas-graph.ts";
import { editorSizeOptions } from "./canvas-image-options.ts";
import { clampViewportScale, legacyNodeToGraphNodes, parseCanvasState, restoreEdges, restoreGraphNodes, stringifyCanvasState, toPersistedEdges, toPersistedGraphNodes, toPersistedNodes, zoomViewportAt } from "./canvas-persist.ts";
import { CANVAS_MAX_SCALE, CANVAS_MIN_SCALE, PROMPT_MAX_LENGTH, type GraphEdge, type GraphNode } from "./canvas-types.ts";

test("将 v2 旧画布状态迁移为 v4 图节点 schema", () => {
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

  assert.equal(restored?.version, 4);
  assert.equal(restored?.canvases?.length, 1);
  assert.equal(restored?.activeCanvasID, "canvas-main");
  assert.equal(restored?.nodes[0]?.id, "node-1");
  // 旧图像卡片迁移为输出节点，保留图像引用
  const migrated = restored?.canvases?.[0]?.graphNodes?.[0];
  assert.equal(migrated?.kind, "output");
  assert.ok(migrated?.kind === "output" && migrated.fileID === "file-1");
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
  });

  const expanded = elasticCanvasBounds(container, [
    { x: 40, y: 420, width: 100, height: 100 },
    { x: 240, y: 180, width: 100, height: 100 },
  ], 240, 20);
  // 边缘 1:1 跟随节点移动：左右各需 80px 扩展，边缘同样外移 80
  assert.equal(expanded.x, 20);
  assert.equal(expanded.y, 160);
  assert.equal(expanded.width, 340);
  assert.equal(expanded.height, 380);
  assert.equal(expanded.appliedExpansion, 160);
  assert.equal(expanded.tension, 2 / 3);
});

test("弹性边界 1:1 跟随且达到拉伸上限后停住", () => {
  const stretched = elasticCanvasBounds(
    { x: 100, y: 100, width: 200, height: 200 },
    [{ x: -100, y: -100, width: 500, height: 500 }],
    120,
    0,
  );
  // 左右各超出 200 -> 跟随 120（上限）；上下各超出 100 -> 跟随 100
  assert.equal(stretched.requestedExpansion, 600);
  assert.equal(stretched.appliedExpansion, 440);
  assert.equal(stretched.x, -20);
  assert.equal(stretched.y, -20);
  assert.equal(stretched.width, 420);
  assert.equal(stretched.height, 420);
  assert.equal(stretched.tension, 1);
});

test("弹性边界无剩余内容时保持容器不变", () => {
  const container = { x: 100, y: 200, width: 200, height: 200 };
  assert.deepEqual(elasticCanvasBounds(container, [], 120), {
    ...container,
    requestedExpansion: 0,
    appliedExpansion: 0,
    tension: 0,
  });
});

test("弹性脱离仅由刻意甩出的瞬时速度触发", () => {
  assert.equal(shouldDetachElasticBoundary({ velocity: 0.4 }), false);
  assert.equal(shouldDetachElasticBoundary({ velocity: 1.35 }), false);
  assert.equal(shouldDetachElasticBoundary({ velocity: 2.9 }), false);
  assert.equal(shouldDetachElasticBoundary({ velocity: 3 }), true);
});

test("Frame 回弹：成员减少时收缩回剩余内容包围盒", () => {
  const frame = { id: "frame", kind: "frame" as const, x: 0, y: 0, width: 400, height: 400, title: "", text: "", color: "indigo", createdAt: 0 };
  const before = [
    { id: "a", x: 40, y: 60, width: 100, height: 100, frameID: "frame" },
    { id: "b", x: 200, y: 200, width: 150, height: 120, frameID: "frame" },
  ];
  const after = [
    { id: "b", x: 200, y: 200, width: 150, height: 120, frameID: "frame" },
  ];
  const refitted = refitFrameDecorations(before, after, [frame]);
  assert.equal(refitted[0]?.x, 176);
  assert.equal(refitted[0]?.y, 176);
  assert.equal(refitted[0]?.width, 198);
  assert.equal(refitted[0]?.height, 168);
});

test("Frame 扩展：成员增加时仅向外扩展容纳新内容", () => {
  const frame = { id: "frame", kind: "frame" as const, x: 0, y: 0, width: 400, height: 400, title: "", text: "", color: "indigo", createdAt: 0 };
  const before = [{ id: "a", x: 40, y: 60, width: 100, height: 100, frameID: "frame" }];
  const after = [
    { id: "a", x: 40, y: 60, width: 100, height: 100, frameID: "frame" },
    // 新成员位于 Frame 右下角之外
    { id: "b", x: 500, y: 500, width: 100, height: 100, frameID: "frame" },
  ];
  const refitted = refitFrameDecorations(before, after, [frame]);
  assert.equal(refitted[0]?.x, 0);
  assert.equal(refitted[0]?.y, 0);
  assert.equal(refitted[0]?.width, 624);
  assert.equal(refitted[0]?.height, 624);
});

test("Frame 回弹跳过锁定与折叠的 Frame 且成员清空时回弹到最小尺寸", () => {
  const lockedFrame = { id: "locked", kind: "frame" as const, x: 0, y: 0, width: 400, height: 400, title: "", text: "", color: "indigo", createdAt: 0, locked: true };
  const emptyFrame = { id: "empty", kind: "frame" as const, x: 10, y: 10, width: 500, height: 500, title: "", text: "", color: "indigo", createdAt: 0 };
  const before = [
    { id: "a", x: 0, y: 0, width: 100, height: 100, frameID: "locked" },
    { id: "b", x: 0, y: 0, width: 100, height: 100, frameID: "empty" },
  ];
  const refitted = refitFrameDecorations(before, [], [lockedFrame, emptyFrame]);
  // 锁定 Frame 保持不变
  assert.deepEqual({ x: refitted[0]?.x, y: refitted[0]?.y, width: refitted[0]?.width, height: refitted[0]?.height }, { x: 0, y: 0, width: 400, height: 400 });
  // 成员清空的 Frame 回弹到最小尺寸
  assert.equal(refitted[1]?.width, 160);
  assert.equal(refitted[1]?.height, 120);
});

test("Frame 边界辅助：成员包围盒与仅向外扩展", () => {
  const members = [
    { id: "a", x: 40, y: 60, width: 100, height: 100 },
    { id: "b", x: 200, y: 200, width: 100, height: 100 },
  ];
  const fitted = frameFitBounds(members, 24);
  assert.deepEqual(fitted, { x: 16, y: 36, width: 308, height: 288 });

  const frame = { x: 0, y: 0, width: 400, height: 400 };
  // 成员 c 仅向右与向上越界（垂直方向仍在 Frame 内），底部保持不变
  const union = frameUnionBounds(frame, [{ id: "c", x: 500, y: -20, width: 50, height: 50 }], 24);
  assert.deepEqual(union, { x: 0, y: -44, width: 574, height: 444 });
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

// ---------------------------------------------------------------------------
// 节点图系统测试
// ---------------------------------------------------------------------------
function sampleGraphNodes(): GraphNode[] {
  return [
    { id: "p1", kind: "prompt", x: 0, y: 0, createdAt: 1, text: "赛博朋克城市" },
    { id: "p2", kind: "prompt", x: 0, y: 300, createdAt: 2, text: "霓虹灯效" },
    {
      id: "img1", kind: "image", x: 0, y: 600, createdAt: 3,
      reference: { fileID: "ref-1", fileName: "ref.png", mimeType: "image/png", sizeBytes: 128 },
    },
    {
      id: "g1", kind: "generate", x: 400, y: 0, createdAt: 4, model: "model-a", options: {},
      resultCount: 1, operation: "generate", runStatus: "idle",
    },
    {
      id: "o1", kind: "output", x: 800, y: 0, createdAt: 5, status: "done", fileID: "file-1",
      fileName: "out.png", mimeType: "image/png", sizeBytes: 256, prompt: "旧提示词", sourceGenerateID: "g1",
    },
  ];
}

function sampleGraphEdges(): GraphEdge[] {
  return [
    { id: "e1", fromNodeID: "p1", toNodeID: "g1", toPort: "prompt", createdAt: 1 },
    { id: "e2", fromNodeID: "p2", toNodeID: "g1", toPort: "prompt", createdAt: 2 },
    { id: "e3", fromNodeID: "img1", toNodeID: "g1", toPort: "image", createdAt: 3 },
    { id: "e4", fromNodeID: "g1", toNodeID: "o1", toPort: "result", createdAt: 4 },
  ];
}

test("图节点 v4 序列化与解析往返保留节点与连线", () => {
  const nodes = sampleGraphNodes();
  const edges = sampleGraphEdges();
  const viewport = { x: 0, y: 0, scale: 1 };
  const roundTripped = parseCanvasState(stringifyCanvasState({
    version: 4, projectName: "graph", activeCanvasID: "c1", conversationID: null,
    selectedModelName: null, pointerMode: "pan", viewport, imageOptions: {},
    canvases: [{
      id: "c1", name: "C1", viewport, nodes: [],
      graphNodes: toPersistedGraphNodes(nodes), edges: toPersistedEdges(edges),
      decorations: [], bookmarks: [], createdAt: 1, updatedAt: 1,
    }],
  }));

  const restoredNodes = restoreGraphNodes(roundTripped?.graphNodes ?? []);
  const restoredEdges = restoreEdges(roundTripped?.edges ?? [], restoredNodes);

  assert.equal(restoredNodes.length, 5);
  assert.equal(restoredEdges.length, 4);
  const prompt = restoredNodes.find((node) => node.id === "p1");
  assert.ok(prompt && isPromptGraphNode(prompt));
  assert.equal(prompt.text, "赛博朋克城市");
  const generate = restoredNodes.find((node) => node.id === "g1");
  assert.ok(generate && generate.kind === "generate");
  // 运行时状态不持久化，恢复后回到 idle
  assert.equal(generate.runStatus, "idle");
  const output = restoredNodes.find((node) => node.id === "o1");
  assert.ok(output && output.kind === "output");
  assert.equal(output.fileID, "file-1");
});

test("v3 旧图像节点迁移为输出节点并保留图像元数据", () => {
  const migrated = legacyNodeToGraphNodes({
    id: "legacy-1", x: 12, y: 34, prompt: "旧提示词", model: "model-a", createdAt: 1,
    status: "done", fileID: "file-9", fileName: "old.png", mimeType: "image/webp", sizeBytes: 64,
  });

  assert.equal(migrated.length, 1);
  const output = migrated[0];
  assert.equal(output.kind, "output");
  assert.equal(output.status, "done");
  assert.ok(output.kind === "output");
  assert.equal(output.fileID, "file-9");
  assert.equal(output.prompt, "旧提示词");
});

test("连线校验：合法连接通过，自连/重复/不兼容/缺失均被拒绝", () => {
  const nodes = sampleGraphNodes();
  const edges = sampleGraphEdges();

  assert.deepEqual(
    canConnectGraphNodes(nodes, edges, { fromNodeID: "o1", fromPort: "out", toNodeID: "g1", toPort: "image" }),
    { ok: true, reason: null },
  );
  assert.equal(
    canConnectGraphNodes(nodes, edges, { fromNodeID: "p1", fromPort: "out", toNodeID: "p1", toPort: "prompt" }).reason,
    "self",
  );
  assert.equal(
    canConnectGraphNodes(nodes, edges, { fromNodeID: "p1", fromPort: "out", toNodeID: "g1", toPort: "prompt" }).reason,
    "duplicate",
  );
  assert.equal(
    canConnectGraphNodes(nodes, edges, { fromNodeID: "p1", fromPort: "out", toNodeID: "o1", toPort: "result" }).reason,
    "incompatible",
  );
  assert.equal(
    canConnectGraphNodes(nodes, edges, { fromNodeID: "ghost", fromPort: "out", toNodeID: "g1", toPort: "prompt" }).reason,
    "missing",
  );
});

test("端口兼容提示与生成节点的合法出线一致", () => {
  assert.equal(isGraphPortCompatibleTarget("prompt", "generate", "prompt"), true);
  assert.equal(isGraphPortCompatibleTarget("prompt", "generate", "image"), false);
  assert.equal(isGraphPortCompatibleTarget("image", "generate", "image"), true);
  assert.equal(isGraphPortCompatibleTarget("generate", "output", "result"), true);
  assert.equal(isGraphPortCompatibleTarget("output", "generate", "image"), true);
  assert.equal(isGraphPortCompatibleTarget(null, "generate", "prompt"), false);
});

test("生成节点输入汇聚：多提示词按序拼接，参考图去重收集，出线单独返回", () => {
  const inputs = gatherGraphGenerateInputs("g1", sampleGraphNodes(), sampleGraphEdges());

  assert.equal(inputs.prompt, "赛博朋克城市\n\n霓虹灯效");
  assert.deepEqual(inputs.promptSourceIDs, ["p1", "p2"]);
  assert.deepEqual(inputs.referenceSourceIDs, ["img1"]);
  assert.equal(inputs.references[0]?.fileID, "ref-1");
  assert.deepEqual(inputs.outputEdges.map((edge) => edge.id), ["e4"]);
});

test("端口几何按固定偏移定位，连线为带控制点的贝塞尔路径", () => {
  const promptNode = { kind: "prompt" as const, x: 100, y: 200 };
  const size = { width: 288 };
  const out = graphPortCanvasPosition(promptNode, "out", size);
  assert.deepEqual(out, { x: 388, y: 260 });
  assert.equal(graphPortCanvasPosition(promptNode, "result", size), null);
  // 每类节点都有出端口，生成节点具备 prompt/image 两个入端口
  assert.ok(graphNodePorts("prompt").some((port) => port.id === "out"));
  assert.deepEqual(graphNodePorts("generate").filter((port) => port.direction === "in").map((port) => port.id), ["prompt", "image"]);

  const path = graphEdgePath({ x: 0, y: 0 }, { x: 300, y: 80 });
  assert.ok(path.startsWith("M 0 0 C "));
  assert.ok(path.endsWith("300 80"));
  const midpoint = graphEdgeMidpoint({ x: 0, y: 0 }, { x: 300, y: 80 });
  assert.ok(midpoint.x > 0 && midpoint.x < 300);
});

test("提示词截断与用户模板创建遵循长度与命名规则", () => {
  assert.equal(promptNodeTruncated("短文本"), "短文本");
  assert.equal(promptNodeTruncated("a".repeat(PROMPT_MAX_LENGTH + 5)).length, PROMPT_MAX_LENGTH);

  // 无 window 环境（node 测试）返回内置模板
  const builtin = loadPromptTemplates();
  assert.ok(builtin.length >= 4);

  const template = createUserPromptTemplate("", "模板内容");
  assert.equal(template.name, "未命名模板");
  assert.ok(template.createdAt > 0);
  assert.equal(createUserPromptTemplate("自定义", "内容").name, "自定义");
});

// 编辑器尺寸同步测试用模型工厂
function editorTestModel(protocols: string[]) {
  return {
    platformModelName: "test-model", icon: "", vendor: "", vendorName: "", vendorIcon: "",
    displayGroupID: null, displayGroupName: "", displayGroupIcon: "",
    kinds: ["image_edit"], protocols,
    defaultOptions: {}, optionControls: [], lockedOptionPaths: [], nativeToolKeys: [], nativeTools: [],
  };
}

test("编辑器输出尺寸同步：OpenAI size 枚举按宽高比就近匹配", () => {
  const model = editorTestModel(["openai_image_edits"]);
  // 3:2 输出 -> 1536x1024；1:1 输出 -> 1024x1024
  assert.equal(editorSizeOptions(model, 1536, 1024).size, "1536x1024");
  assert.equal(editorSizeOptions(model, 1200, 1200).size, "1024x1024");
});

test("编辑器输出尺寸同步：比例与分辨率档位参数按输出尺寸匹配", () => {
  const model = editorTestModel(["gemini_interactions"]);
  const wide = editorSizeOptions(model, 2048, 1152);
  assert.equal(wide.response_format?.aspect_ratio, "16:9");
  // 2048x1152 ≈ 2.36MP -> 2K 档
  assert.equal(wide.response_format?.image_size, "2K");
  // 800x600 ≈ 0.48MP -> 1K 档
  const small = editorSizeOptions(model, 800, 600);
  assert.equal(small.response_format?.aspect_ratio, "4:3");
  assert.equal(small.response_format?.image_size, "1K");
});

test("编辑器输出尺寸同步：非法尺寸返回空参数", () => {
  const model = editorTestModel(["openai_image_edits"]);
  assert.deepEqual(editorSizeOptions(model, 0, 100), {});
  assert.deepEqual(editorSizeOptions(null, 100, 100), {});
});
