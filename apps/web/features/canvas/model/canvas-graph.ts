import { CANVAS_NODE_REGISTRY } from "@/features/canvas/model/canvas-node-registry";
import {
  type CanvasMediaKind,
  type CanvasMediaType,
  type GraphEdge,
  type GraphInputPort,
  type GraphNode,
  type GraphNodeKind,
  type OutputGraphNode,
  PROMPT_MAX_LENGTH,
  PROMPT_TEMPLATES_STORAGE_KEY,
  type PromptGraphNode,
} from "./canvas-types.ts";

// ---------------------------------------------------------------------------
// 端口几何：所有节点尺寸固定，端口按节点种类以固定偏移定位
// ---------------------------------------------------------------------------
export type GraphPortDirection = "in" | "out";
export type GraphPortDefinition = {
  id: GraphPortID;
  direction: GraphPortDirection;
  // 相对节点左上角的偏移；x 为 0（入端口）或节点宽度（出端口）
  offsetX: number;
  offsetY: number;
};

export type GraphPortID = "out" | "prompt" | "image" | "video" | "audio" | "result";

// 端口定义从节点注册表派生：按节点类型与媒体类型取（视频生成节点有额外的参考视频 / 音频入端口）
export function graphNodePorts(kind: GraphNodeKind, mediaType?: CanvasMediaType): GraphPortDefinition[] {
  const entry = CANVAS_NODE_REGISTRY[kind];
  const override = mediaType ? entry.portsByMediaType?.[mediaType] : undefined;
  return override ?? entry.ports;
}

export function graphPortSize(
  kind: GraphNodeKind,
  portID: GraphPortID,
  mediaType?: CanvasMediaType,
): GraphPortDefinition | null {
  return graphNodePorts(kind, mediaType).find((port) => port.id === portID) ?? null;
}

// 生成节点的端口在合并后的卡片上固定分布，不再随上游清单行数变化
export function graphPortOffsetY(
  kind: GraphNodeKind,
  portID: GraphPortID,
  mediaType?: CanvasMediaType,
): number {
  const ports = graphNodePorts(kind, mediaType);
  return ports.find((item) => item.id === portID)?.offsetY ?? 0;
}

// 端口在画布坐标系中的绝对位置。
// 画布采用「单连接点」交互：出线统一从节点右缘中点引出、入线统一落到左缘中点，
// 连线端点因此与指针悬浮点的位置无关，多条参考内容也会汇聚到同一处，视觉更干净。
export function graphPortCanvasPosition(
  node: Pick<GraphNode, "kind" | "x" | "y"> & { mediaType?: CanvasMediaType; portRowCounts?: number[] },
  portID: GraphPortID,
  size: { width: number; height: number },
): { x: number; y: number } | null {
  const port = graphPortSize(node.kind, portID, node.mediaType);
  if (!port) {
    return null;
  }
  return {
    x: node.x + (port.direction === "out" ? size.width : 0),
    y: node.y + size.height / 2,
  };
}

// 单连接点连线的目标端口推断：按来源节点种类与媒体类型自动选择入端口，
// 用户只需要把点拖到目标节点上，不再区分提示词 / 参考图 / 参考视频等具体落点。
export function inferGraphConnectionPorts(
  source: GraphNode,
  target: GraphNode,
): GraphInputPort[] {
  const rules = GRAPH_CONNECTION_RULES[source.kind].filter((rule) => rule.toKind === target.kind);
  if (rules.length <= 1) {
    return rules.map((rule) => rule.toPort);
  }
  // 媒体节点的参考素材类型决定接入参考视频还是参考音频端口
  if (source.kind === "media" && source.mediaKind) {
    const matched = rules.filter((rule) => rule.toPort === source.mediaKind);
    if (matched.length > 0) {
      return matched.map((rule) => rule.toPort);
    }
  }
  // 生成 / 输出节点按产物媒体类型决定接到参考图还是参考视频端口
  if ((source.kind === "generate" || source.kind === "output") && source.mediaType) {
    const matched = rules.filter((rule) => rule.toPort === source.mediaType);
    if (matched.length > 0) {
      return matched.map((rule) => rule.toPort);
    }
  }
  return rules.map((rule) => rule.toPort);
}

// 三次贝塞尔连线路径，控制点随水平距离自适应，保证水平出线的流畅感
export function graphEdgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const controlOffset = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + controlOffset} ${from.y}, ${to.x - controlOffset} ${to.y}, ${to.x} ${to.y}`;
}

// 贝塞尔曲线中点（t = 0.5），用于连线删除按钮定位
export function graphEdgeMidpoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const controlOffset = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  const c1x = from.x + controlOffset;
  const c2x = to.x - controlOffset;
  return {
    x: (from.x + 3 * c1x + 3 * c2x + to.x) / 8,
    y: (from.y + 3 * from.y + 3 * to.y + to.y) / 8,
  };
}

// 贝塞尔曲线上的参数点：t ∈ [0,1]，用于删除按钮跟随鼠标在线条上任意位置显示
export function graphEdgePointAt(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const controlOffset = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  const c1 = { x: from.x + controlOffset, y: from.y };
  const c2 = { x: to.x - controlOffset, y: to.y };
  const mt = 1 - t;
  return {
    x: mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x,
    y: mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y,
  };
}

// 曲线上离指针最近的点：采样近似即可满足 hover 命中与按钮定位
export function graphEdgeNearestPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  point: { x: number; y: number },
  steps = 24,
): { x: number; y: number; distance: number } {
  let best = { x: from.x, y: from.y, distance: Number.POSITIVE_INFINITY };
  for (let index = 0; index <= steps; index += 1) {
    const sample = graphEdgePointAt(from, to, index / steps);
    const distance = Math.hypot(sample.x - point.x, sample.y - point.y);
    if (distance < best.distance) {
      best = { ...sample, distance };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 连线规则：提示词 -> 生成(提示词)；参考图/输出 -> 生成(参考图)；生成 -> 输出
// ---------------------------------------------------------------------------
export type GraphConnectionAttempt = {
  fromNodeID: string;
  fromPort: "out";
  toNodeID: string;
  toPort: GraphInputPort;
  // 时间线自定义轨道：指定片段落到哪条轨道，缺省落到该端口对应的内置轨
  trackID?: string;
};

// 连线规则从节点注册表派生：提示词 -> 生成(提示词)；参考图/输出 -> 生成(参考图)；生成 -> 输出
const GRAPH_CONNECTION_RULES: Record<GraphNodeKind, { toKind: GraphNodeKind; toPort: GraphInputPort }[]> =
  Object.fromEntries(
    Object.values(CANVAS_NODE_REGISTRY).map((entry) => [entry.kind, entry.connectionRules] as const),
  ) as Record<GraphNodeKind, { toKind: GraphNodeKind; toPort: GraphInputPort }[]>;

// 媒体类型兼容性：视频产物不能作为图像参考图回灌；参考视频 / 参考音频端口只接受
// 对应素材类型的媒体节点或同类型的生成产物。生成结果已合并进生成节点，因此
// 生成节点本身也可以作为参考来源（取其最近一次成功产物）。
export type GraphMediaCarrier = { kind: GraphNodeKind; mediaType?: CanvasMediaType; mediaKind?: CanvasMediaKind };

export function graphMediaCompatible(
  from: GraphMediaCarrier | undefined,
  to: GraphMediaCarrier | undefined,
  toPort: GraphInputPort,
): boolean {
  if (toPort === "prompt") {
    return true;
  }
  if (toPort === "image") {
    // 参考图入端口：来源必须是图像（参考图节点、图像输出或图像生成节点）
    return !((from?.kind === "output" || from?.kind === "generate") && from.mediaType === "video");
  }
  if (toPort === "video" || toPort === "audio") {
    // 时间线节点：视频轨只接收视频，音频轨只接收音频素材
    if (to?.kind === "timeline") {
      if (toPort === "video") {
        if (from?.kind === "media") {
          return from.mediaKind === "video";
        }
        return (from?.kind === "generate" || from?.kind === "output") && from.mediaType === "video";
      }
      return from?.kind === "media" && from.mediaKind === "audio";
    }
    // 参考素材入端口：只有视频生成节点提供，且素材类型必须与端口一致。
    if (!(to?.kind === "generate" && to.mediaType === "video")) {
      return false;
    }
    if (from?.kind === "media") {
      return from.mediaKind === toPort;
    }
    // 时间线导出即视频，可作为视频生成节点的参考视频输入
    if (from?.kind === "timeline") {
      return toPort === "video";
    }
    return from?.kind === "output" && from.mediaType === toPort;
  }
  if (toPort === "result") {
    // 结果入端口：目标输出节点已定型为另一媒体类型时不兼容（兼容旧数据）
    if (to?.kind === "output" && to.mediaType && from?.kind === "generate" && from.mediaType && to.mediaType !== from.mediaType) {
      return false;
    }
    return true;
  }
  return true;
}

export function graphConnectionTargets(
  sourceKind: GraphNodeKind,
): { toKind: GraphNodeKind; toPort: GraphInputPort }[] {
  return GRAPH_CONNECTION_RULES[sourceKind];
}

// 校验一次连线意图：出端口只能连向兼容的入端口，且禁止自连与重复连线
export function canConnectGraphNodes(
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
  attempt: GraphConnectionAttempt,
): { ok: boolean; reason: "self" | "incompatible" | "duplicate" | "missing" | null } {
  const from = nodes.find((node) => node.id === attempt.fromNodeID);
  const to = nodes.find((node) => node.id === attempt.toNodeID);
  if (!from || !to) {
    return { ok: false, reason: "missing" };
  }
  if (from.id === to.id) {
    return { ok: false, reason: "self" };
  }
  const compatible = GRAPH_CONNECTION_RULES[from.kind].some(
    (rule) => rule.toKind === to.kind && rule.toPort === attempt.toPort,
  );
  if (!compatible) {
    return { ok: false, reason: "incompatible" };
  }
  if (!graphMediaCompatible(from, to, attempt.toPort)) {
    return { ok: false, reason: "incompatible" };
  }
  if (edges.some((edge) => edge.fromNodeID === attempt.fromNodeID && edge.toNodeID === attempt.toNodeID && edge.toPort === attempt.toPort)) {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true, reason: null };
}

// 拖拽中的端口是否为 source 端口的合法落点（用于高亮提示）
export function isGraphPortCompatibleTarget(
  sourceKind: GraphNodeKind | null,
  targetKind: GraphNodeKind,
  targetPort: GraphPortID,
  sourceMediaKind?: CanvasMediaKind,
): boolean {
  if (!sourceKind) {
    return false;
  }
  if (targetPort === "video" || targetPort === "audio") {
    // 时间线节点：视频轨接受视频来源，音频轨只接受音频素材
    if (targetKind === "timeline") {
      if (targetPort === "video") {
        return sourceKind === "media" ? sourceMediaKind === "video" : sourceKind === "generate" || sourceKind === "output";
      }
      return sourceKind === "media" && sourceMediaKind === "audio";
    }
    // 素材端口：媒体节点按素材类型匹配；生成节点可能产出视频，允许高亮，
    // 最终是否可连仍由 canConnectGraphNodes 的媒体类型校验决定
    return (sourceKind === "media" && sourceMediaKind === targetPort) || sourceKind === "generate";
  }
  return GRAPH_CONNECTION_RULES[sourceKind].some(
    (rule) => rule.toKind === targetKind && rule.toPort === targetPort,
  );
}

// ---------------------------------------------------------------------------
// 上游连接清单：生成节点内按行展示每个入端口已连接的内容（色点标识来源类型）
// ---------------------------------------------------------------------------
export type GraphConnectionSummary = {
  id: string;
  kind: GraphNodeKind;
  // 落点入端口：区分「参考视频 / 参考音频」等同类型来源
  port: GraphPortID;
  label: string;
};
// 入端口汇总：每个入端口一行，connections 为空表示该端口尚未连接。
// 端口清单而非「已连接清单」——未连接的端口同样要显示，用户才知道每个点该连什么
export type GraphNodeInputPortSummary = {
  port: GraphPortID;
  connections: GraphConnectionSummary[];
};

export type GraphNodeInputSummary = {
  ports: GraphNodeInputPortSummary[];
};

// 用户自带密钥的模型编码为 personal:<providerID>/<model>；
// 节点与清单展示只保留上游模型名，避免把内部渠道标识暴露到界面
export function graphModelDisplayName(modelName: string): string {
  const value = modelName.trim();
  return /^personal:[a-z0-9]{8,32}\/(.+)$/.exec(value)?.[1] ?? value;
}

// 连接行的节点显示名：按节点类型取最有语义的文本（与资产侧栏 / 画布上下文一致）
export function graphConnectionLabel(node: GraphNode, fallback: string): string {
  switch (node.kind) {
    case "prompt":
      return node.text.trim() || fallback;
    case "image":
      return node.reference?.fileName || fallback;
    case "media":
      return node.reference?.fileName || fallback;
    case "generate":
      return node.model ? graphModelDisplayName(node.model) : fallback;
    case "output":
      return (node.status === "done" ? node.fileName : null) || node.prompt?.trim() || fallback;
    case "timeline":
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// 图执行输入汇聚：按连线创建顺序拼接提示词，收集参考图与输出连线
// ---------------------------------------------------------------------------
export type GraphReference = { fileID: string; fileName: string; mimeType: string; sizeBytes: number };

export type GraphGenerateInputs = {
  prompt: string;
  promptSourceIDs: string[];
  references: GraphReference[];
  referenceSourceIDs: string[];
  // 视频生成节点的参考视频与参考音频素材
  videoReferences: GraphReference[];
  videoReferenceSourceIDs: string[];
  audioReferences: GraphReference[];
  audioReferenceSourceIDs: string[];
  outputEdges: GraphEdge[];
};

function referenceOfNode(node: GraphNode, nodeByID: ReadonlyMap<string, GraphNode>): GraphReference | null {
  if (node.kind === "image" && node.reference) {
    return node.reference;
  }
  if (node.kind === "media" && node.reference) {
    return node.reference;
  }
  if (node.kind === "generate") {
    // 生成节点作为参考来源时取最近一次成功产物（输出节点已吸收进生成节点卡片）
    const latest = [...nodeByID.values()]
      .filter((item): item is OutputGraphNode => item.kind === "output" && item.sourceGenerateID === node.id && item.status === "done" && Boolean(item.fileID))
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);
    return latest ? {
      fileID: latest.fileID ?? "",
      fileName: latest.fileName ?? "image.png",
      mimeType: latest.mimeType ?? "image/png",
      sizeBytes: latest.sizeBytes ?? 0,
    } : null;
  }
  if (node.kind === "output" && node.status === "done" && node.fileID) {
    return {
      fileID: node.fileID,
      fileName: node.fileName ?? "image.png",
      mimeType: node.mimeType ?? "image/png",
      sizeBytes: node.sizeBytes ?? 0,
    };
  }
  return null;
}

export function gatherGraphGenerateInputs(
  generateNodeID: string,
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
): GraphGenerateInputs {
  const orderedEdges = [...edges].sort((a, b) => a.createdAt - b.createdAt);
  const promptTexts: string[] = [];
  const promptSourceIDs: string[] = [];
  const references: GraphReference[] = [];
  const referenceSourceIDs: string[] = [];
  const videoReferences: GraphReference[] = [];
  const videoReferenceSourceIDs: string[] = [];
  const audioReferences: GraphReference[] = [];
  const audioReferenceSourceIDs: string[] = [];
  const outputEdges: GraphEdge[] = [];

  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of orderedEdges) {
    if (edge.toNodeID === generateNodeID && edge.toPort === "prompt") {
      const source = nodeByID.get(edge.fromNodeID);
      if (source && source.kind === "prompt" && source.text.trim()) {
        promptTexts.push(source.text.trim());
        promptSourceIDs.push(source.id);
      }
    }
    if (edge.toNodeID === generateNodeID && edge.toPort === "image") {
      const source = nodeByID.get(edge.fromNodeID);
      const reference = source ? referenceOfNode(source, nodeByID) : null;
      if (reference && !references.some((item) => item.fileID === reference.fileID)) {
        references.push(reference);
        referenceSourceIDs.push(edge.fromNodeID);
      }
    }
    if (edge.toNodeID === generateNodeID && edge.toPort === "video") {
      const source = nodeByID.get(edge.fromNodeID);
      const reference = source ? referenceOfNode(source, nodeByID) : null;
      if (reference && !videoReferences.some((item) => item.fileID === reference.fileID)) {
        videoReferences.push(reference);
        videoReferenceSourceIDs.push(edge.fromNodeID);
      }
    }
    if (edge.toNodeID === generateNodeID && edge.toPort === "audio") {
      const source = nodeByID.get(edge.fromNodeID);
      const reference = source ? referenceOfNode(source, nodeByID) : null;
      if (reference && !audioReferences.some((item) => item.fileID === reference.fileID)) {
        audioReferences.push(reference);
        audioReferenceSourceIDs.push(edge.fromNodeID);
      }
    }
    if (edge.fromNodeID === generateNodeID && edge.toPort === "result") {
      outputEdges.push(edge);
    }
  }

  return {
    prompt: promptTexts.join("\n\n"),
    promptSourceIDs,
    references,
    referenceSourceIDs,
    videoReferences,
    videoReferenceSourceIDs,
    audioReferences,
    audioReferenceSourceIDs,
    outputEdges,
  };
}

// 生成节点是否具备可运行的提示词或参考图
export function graphGenerateHasInputs(inputs: GraphGenerateInputs): boolean {
  return inputs.prompt.trim().length > 0
    || inputs.references.length > 0
    || inputs.videoReferences.length > 0
    || inputs.audioReferences.length > 0;
}

export function promptNodeTruncated(text: string): string {
  return text.length > PROMPT_MAX_LENGTH ? text.slice(0, PROMPT_MAX_LENGTH) : text;
}

export function isPromptGraphNode(node: GraphNode): node is PromptGraphNode {
  return node.kind === "prompt";
}

// ---------------------------------------------------------------------------
// 提示词模板库：localStorage 持久化，用户可自行添加与删除
// ---------------------------------------------------------------------------
export type PromptTemplate = { id: string; name: string; text: string; createdAt: number };

const BUILTIN_PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: "tpl-cinematic", name: "电影感人像", text: "电影感人像，柔和的伦勃朗光，浅景深，35mm 胶片质感，细腻的皮肤纹理，深色背景，低调氛围", createdAt: 0 },
  { id: "tpl-product", name: "产品静物", text: "产品静物摄影，纯色无缝背景，顶部柔光箱布光，轻微反射地面，锐利细节，商业广告风格", createdAt: 0 },
  { id: "tpl-anime", name: "赛博朋克城市", text: "赛博朋克城市夜景，霓虹灯牌，雨后湿润的街道反光，体积光，高对比，宽幅构图，动漫风格", createdAt: 0 },
  { id: "tpl-watercolor", name: "水彩插画", text: "水彩插画，柔和的晕染边缘，留白构图，清淡的暖色调，纸面纹理，手绘笔触", createdAt: 0 },
];

export function loadPromptTemplates(): PromptTemplate[] {
  if (typeof window === "undefined") {
    return [...BUILTIN_PROMPT_TEMPLATES];
  }
  try {
    const raw = window.localStorage.getItem(PROMPT_TEMPLATES_STORAGE_KEY);
    if (!raw) {
      return [...BUILTIN_PROMPT_TEMPLATES];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...BUILTIN_PROMPT_TEMPLATES];
    }
    const userTemplates = parsed.flatMap((item): PromptTemplate[] => {
      const value = item as Partial<PromptTemplate> | null;
      if (!value || typeof value.id !== "string" || typeof value.text !== "string" || !value.text.trim()) {
        return [];
      }
      return [{
        id: value.id,
        name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "未命名模板",
        text: value.text,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      }];
    });
    return [...BUILTIN_PROMPT_TEMPLATES, ...userTemplates];
  } catch {
    return [...BUILTIN_PROMPT_TEMPLATES];
  }
}

export function saveUserPromptTemplates(templates: ReadonlyArray<PromptTemplate>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    // 内置模板不入库，仅持久化用户模板
    const userTemplates = templates.filter((item) => item.createdAt !== 0);
    window.localStorage.setItem(PROMPT_TEMPLATES_STORAGE_KEY, JSON.stringify(userTemplates));
  } catch {
    // 存储失败时静默降级
  }
}

export function createUserPromptTemplate(name: string, text: string): PromptTemplate {
  return {
    id: `tpl-user-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name.trim() || "未命名模板",
    text: promptNodeTruncated(text),
    createdAt: Date.now(),
  };
}
