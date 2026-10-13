import type { GraphEdge, GraphNode, GraphNodeKind } from "./canvas-types.ts";

// ---------------------------------------------------------------------------
// 画布上下文汇总：把画布节点图压缩为一段 Markdown 文本，供对话注入。
// 纯函数，无 React、无副作用；注意力放在可读性与长度可控上。
// ---------------------------------------------------------------------------

export type CanvasContextOptions = {
  // 汇总文本总长度上限（字符），超出后按行边界安全截断
  maxChars?: number;
  // 单个提示词 / HTML 源码摘要的截断长度
  snippetMaxChars?: number;
};

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_SNIPPET_MAX_CHARS = 160;

// 节点类型的可读名称
const KIND_LABELS: Record<GraphNodeKind, string> = {
  prompt: "提示词",
  image: "参考图",
  generate: "生成",
  output: "输出",
  html: "HTML",
};

// 折叠空白并按上限截断，超长补省略号
function snippet(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

// 单节点单行描述
function describeNode(node: GraphNode, index: number, snippetMax: number): string {
  const prefix = `${index + 1}. ${KIND_LABELS[node.kind]}`;
  switch (node.kind) {
    case "prompt":
      return `${prefix}：${node.text.trim() ? snippet(node.text, snippetMax) : "（空提示词）"}`;
    case "image":
      return `${prefix}：${node.reference ? node.reference.fileName : "（无参考图）"}`;
    case "generate": {
      const media = node.mediaType === "video" ? "视频" : "图像";
      return `${prefix}：模型 ${node.model ?? "未选择"} · ${media} · 操作 ${node.operation}`;
    }
    case "output": {
      const hasArtifact = node.status === "done" && Boolean(node.fileID);
      return `${prefix}：模型 ${node.model ?? "未知"} · 状态 ${node.status} · 产物 ${hasArtifact ? node.fileName ?? "有" : "无"}`;
    }
    case "html":
      return `${prefix}：${node.html.trim() ? snippet(node.html, snippetMax) : "（空源码）"}`;
  }
}

export function buildCanvasContextSummary(
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
  options: CanvasContextOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const snippetMax = options.snippetMaxChars ?? DEFAULT_SNIPPET_MAX_CHARS;

  if (nodes.length === 0) {
    return "# 画布上下文\n画布为空，暂无节点。";
  }

  // 以节点在数组中的顺序作为对外序号，便于模型理解（不用内部 UUID）
  const indexByID = new Map<string, number>();
  nodes.forEach((node, index) => indexByID.set(node.id, index));

  const nodeLines = nodes.map((node, index) => `- ${describeNode(node, index, snippetMax)}`);

  const edgeLines = edges.flatMap((edge) => {
    const from = indexByID.get(edge.fromNodeID);
    const to = indexByID.get(edge.toNodeID);
    if (from === undefined || to === undefined) {
      return [];
    }
    return [`- ${from + 1} -> ${to + 1}（${edge.toPort}）`];
  });

  const sections = [
    "# 画布上下文",
    `节点（共 ${nodes.length} 个）：`,
    ...nodeLines,
    `连线（共 ${edgeLines.length} 条）：`,
    ...(edgeLines.length > 0 ? edgeLines : ["- 无"]),
  ];
  const summary = sections.join("\n");

  if (summary.length <= maxChars) {
    return summary;
  }
  // 安全截断：优先在最近的换行边界收尾，避免截断到半行
  const boundary = summary.lastIndexOf("\n", maxChars);
  return `${summary.slice(0, boundary > 0 ? boundary : maxChars)}…`;
}
