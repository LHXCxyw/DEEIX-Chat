import { canvasAssetKind, type CanvasPromptAssetKind } from "@/features/canvas/model/canvas-prompt";
import type { CanvasNodeReference, GraphEdge, GraphInputPort, GraphNode } from "@/features/canvas/model/canvas-types";

// 画布素材条目：把参考图 / 参考媒体 / 生成结果统一成可在对话框与资产库中展示的形态
export type CanvasAssetEntry = {
  reference: CanvasNodeReference;
  kind: CanvasPromptAssetKind;
  // 已缓存的预览地址（objectURL）；没有时由调用方按 fileID 懒加载
  previewURL?: string;
  // 来源节点：用于定位与展示分组
  sourceNodeID: string;
  // 来源生成节点（结果素材）
  sourceGenerateID?: string | null;
};

function referenceOf(node: GraphNode): CanvasNodeReference | null {
  if (node.kind === "image" || node.kind === "media") {
    return node.reference;
  }
  if (node.kind === "output" && node.status === "done" && node.fileID) {
    return {
      fileID: node.fileID,
      fileName: node.fileName ?? "media",
      mimeType: node.mimeType ?? "",
      sizeBytes: node.sizeBytes ?? 0,
    };
  }
  return null;
}

function previewOf(node: GraphNode): string | undefined {
  if (node.kind === "image" || node.kind === "media") {
    return node.previewURL;
  }
  if (node.kind === "output" && node.status === "done") {
    return node.objectURL;
  }
  return undefined;
}

// 生成节点的结果素材：取最近一次成功产物
export function latestResultAsset(nodes: ReadonlyArray<GraphNode>, generateNodeID: string): CanvasAssetEntry | null {
  const latest = nodes
    .filter((node) => node.kind === "output" && node.sourceGenerateID === generateNodeID && node.status === "done" && node.fileID)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .at(-1);
  if (!latest || latest.kind !== "output") {
    return null;
  }
  const reference = referenceOf(latest);
  return reference ? {
    reference,
    kind: canvasAssetKind(reference.mimeType, reference.fileName),
    previewURL: previewOf(latest),
    sourceNodeID: latest.id,
    sourceGenerateID: generateNodeID,
  } : null;
}

// 画布全部可用素材：参考图、参考视频/音频与已完成的生成结果
export function buildCanvasAssetIndex(nodes: ReadonlyArray<GraphNode>): CanvasAssetEntry[] {
  const entries: CanvasAssetEntry[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const reference = referenceOf(node);
    if (!reference || seen.has(reference.fileID)) {
      continue;
    }
    seen.add(reference.fileID);
    entries.push({
      reference,
      kind: canvasAssetKind(reference.mimeType, reference.fileName),
      previewURL: previewOf(node),
      sourceNodeID: node.id,
      sourceGenerateID: node.kind === "output" ? node.sourceGenerateID ?? null : null,
    });
  }
  return entries;
}

export type NodeEdgeAsset = CanvasAssetEntry & { edgeID: string; port: GraphInputPort };

// 已连入指定生成节点的素材：按连线顺序返回，删除时按 edgeID 断开
export function edgeAssetsForNode(
  nodeID: string,
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
): NodeEdgeAsset[] {
  const byID = new Map(nodes.map((node) => [node.id, node]));
  const result: NodeEdgeAsset[] = [];
  const seen = new Set<string>();
  for (const edge of [...edges].filter((item) => item.toNodeID === nodeID && (item.toPort === "image" || item.toPort === "video" || item.toPort === "audio")).sort((a, b) => a.createdAt - b.createdAt)) {
    const source = byID.get(edge.fromNodeID);
    if (!source) {
      continue;
    }
    const reference = source.kind === "generate"
      ? latestResultAsset(nodes, source.id)?.reference ?? null
      : referenceOf(source);
    if (!reference || seen.has(reference.fileID)) {
      continue;
    }
    seen.add(reference.fileID);
    result.push({
      reference,
      kind: canvasAssetKind(reference.mimeType, reference.fileName),
      previewURL: source.kind === "generate" ? latestResultAsset(nodes, source.id)?.previewURL : previewOf(source),
      sourceNodeID: source.id,
      sourceGenerateID: source.kind === "generate" ? source.id : null,
      edgeID: edge.id,
      port: edge.toPort,
    });
  }
  return result;
}
