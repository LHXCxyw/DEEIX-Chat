import {
  PROMPT_MAX_LENGTH,
  PROMPT_TEMPLATES_STORAGE_KEY,
  type GraphEdge,
  type GraphInputPort,
  type GraphNode,
  type GraphNodeKind,
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

export type GraphPortID = "out" | "prompt" | "image" | "result";

export const GRAPH_NODE_PORTS: Record<GraphNodeKind, GraphPortDefinition[]> = {
  prompt: [{ id: "out", direction: "out", offsetX: 1, offsetY: 60 }],
  image: [{ id: "out", direction: "out", offsetX: 1, offsetY: 60 }],
  // 生成节点：提示词与参考图两个入端口位于左侧，结果出端口位于右侧
  generate: [
    { id: "prompt", direction: "in", offsetX: 0, offsetY: 96 },
    { id: "image", direction: "in", offsetX: 0, offsetY: 188 },
    { id: "out", direction: "out", offsetX: 1, offsetY: 300 },
  ],
  output: [
    { id: "result", direction: "in", offsetX: 0, offsetY: 176 },
    { id: "out", direction: "out", offsetX: 1, offsetY: 60 },
  ],
};

export function graphNodePorts(kind: GraphNodeKind): GraphPortDefinition[] {
  return GRAPH_NODE_PORTS[kind];
}

export function graphPortSize(kind: GraphNodeKind, portID: GraphPortID): GraphPortDefinition | null {
  return GRAPH_NODE_PORTS[kind].find((port) => port.id === portID) ?? null;
}

// 端口在画布坐标系中的绝对位置
export function graphPortCanvasPosition(
  node: Pick<GraphNode, "kind" | "x" | "y">,
  portID: GraphPortID,
  size: { width: number },
): { x: number; y: number } | null {
  const port = graphPortSize(node.kind, portID);
  if (!port) {
    return null;
  }
  return {
    x: node.x + port.offsetX * size.width,
    y: node.y + port.offsetY,
  };
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

// ---------------------------------------------------------------------------
// 连线规则：提示词 -> 生成(提示词)；参考图/输出 -> 生成(参考图)；生成 -> 输出
// ---------------------------------------------------------------------------
export type GraphConnectionAttempt = {
  fromNodeID: string;
  fromPort: "out";
  toNodeID: string;
  toPort: GraphInputPort;
};

const GRAPH_CONNECTION_RULES: Record<GraphNodeKind, { toKind: GraphNodeKind; toPort: GraphInputPort }[]> = {
  prompt: [{ toKind: "generate", toPort: "prompt" }],
  image: [{ toKind: "generate", toPort: "image" }],
  generate: [{ toKind: "output", toPort: "result" }],
  output: [{ toKind: "generate", toPort: "image" }],
};

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
): boolean {
  if (!sourceKind) {
    return false;
  }
  return GRAPH_CONNECTION_RULES[sourceKind].some(
    (rule) => rule.toKind === targetKind && rule.toPort === targetPort,
  );
}

// ---------------------------------------------------------------------------
// 图执行输入汇聚：按连线创建顺序拼接提示词，收集参考图与输出连线
// ---------------------------------------------------------------------------
export type GraphGenerateInputs = {
  prompt: string;
  promptSourceIDs: string[];
  references: { fileID: string; fileName: string; mimeType: string; sizeBytes: number }[];
  referenceSourceIDs: string[];
  outputEdges: GraphEdge[];
};

function referenceOfNode(node: GraphNode): { fileID: string; fileName: string; mimeType: string; sizeBytes: number } | null {
  if (node.kind === "image" && node.reference) {
    return node.reference;
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
  const references: NonNullable<ReturnType<typeof referenceOfNode>>[] = [];
  const referenceSourceIDs: string[] = [];
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
      const reference = source ? referenceOfNode(source) : null;
      if (reference && !references.some((item) => item.fileID === reference.fileID)) {
        references.push(reference);
        referenceSourceIDs.push(edge.fromNodeID);
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
    outputEdges,
  };
}

// 生成节点是否具备可运行的提示词或参考图
export function graphGenerateHasInputs(inputs: GraphGenerateInputs): boolean {
  return inputs.prompt.trim().length > 0 || inputs.references.length > 0;
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
