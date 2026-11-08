import { parseRecord, stringValue } from "@/features/chat/model/project-file-changes";
import type { ChatAreaMessage, ChatMessageProcessTrace } from "@/features/chat/types/messages";

// 文件交付工具名：agent 通过它返回限时下载链接，前端据此渲染下载卡片。
export const DELIVERED_FILES_TOOL_NAME = "project_deliver_files";

export type DeliveredFile = {
  key: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
};

export type DeliveredArchive = {
  fileName: string;
  fileCount: number;
  totalBytes: number;
  downloadUrl: string;
};

export type DeliveredFilesPayload = {
  files: DeliveredFile[];
  archive: DeliveredArchive | null;
  totalBytes: number;
  truncated: boolean;
};

function numberValue(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// 依次尝试多个输出字段：详情版优先，截断版兜底；解析失败即跳过。
function toolOutput(call: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ["output_detail", "output", "output_text", "output_preview"]) {
    const record = parseRecord(call[key]);
    if (record) {
      return record;
    }
  }
  return null;
}

// 工具调用是否失败：失败的结果不渲染下载卡片，避免暴露不可用链接。
function isFailedCall(call: Record<string, unknown>): boolean {
  const status = stringValue(call, "status").toLowerCase();
  return status === "error" || status === "failed";
}

// 摘要轨迹会移除工具输出详情；命中交付工具时需要按需拉取完整轨迹才能渲染卡片。
export function hasDeliveredFilesSummary(trace: ChatMessageProcessTrace | undefined): boolean {
  const sources = [trace?.tools, ...(trace?.events ?? [])];
  return sources.some((source) => {
    const payload = parseRecord(source?.payloadJson);
    const calls = payload && Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
    return calls.some((rawCall) => stringValue(parseRecord(rawCall), "name").trim() === DELIVERED_FILES_TOOL_NAME);
  });
}

function tracePayloads(message: ChatAreaMessage): Array<Record<string, unknown> | null> {
  const events = message.processTrace?.events ?? [];
  if (events.length > 0) {
    return events.map((event) => parseRecord(event.payloadJson));
  }
  const tools = message.processTrace?.tools;
  return tools ? [parseRecord(tools.payloadJson)] : [];
}

// 从消息轨迹中提取 project_deliver_files 的交付结果；没有交付调用时返回 null。
export function deliveredFilesFromMessage(message: ChatAreaMessage): DeliveredFilesPayload | null {
  const byPath = new Map<string, DeliveredFile>();
  let archive: DeliveredArchive | null = null;
  let totalBytes = 0;
  let truncated = false;
  let found = false;

  for (const payload of tracePayloads(message)) {
    if (!payload) {
      continue;
    }
    const calls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
    for (const rawCall of calls) {
      const call = parseRecord(rawCall);
      if (!call || stringValue(call, "name").trim() !== DELIVERED_FILES_TOOL_NAME || isFailedCall(call)) {
        continue;
      }
      const output = toolOutput(call);
      if (!output) {
        continue;
      }
      found = true;
      totalBytes = numberValue(output, "total_bytes") || totalBytes;
      truncated = output.truncated === true;
      const rawFiles = Array.isArray(output.files) ? output.files : [];
      for (const rawFile of rawFiles) {
        const file = parseRecord(rawFile);
        if (!file) {
          continue;
        }
        const path = stringValue(file, "path");
        if (!path) {
          continue;
        }
        byPath.set(path, {
          key: `${message.key}:${path}`,
          path,
          fileName: stringValue(file, "file_name") || path,
          sizeBytes: numberValue(file, "size_bytes"),
          downloadUrl: stringValue(file, "download_url"),
        });
      }
      const rawArchive = parseRecord(output.archive);
      if (rawArchive) {
        archive = {
          fileName: stringValue(rawArchive, "file_name") || "workspace-files.zip",
          fileCount: numberValue(rawArchive, "file_count"),
          totalBytes: numberValue(rawArchive, "total_bytes"),
          downloadUrl: stringValue(rawArchive, "download_url"),
        };
      }
    }
  }

  if (!found) {
    return null;
  }
  const files = Array.from(byPath.values());
  if (files.length === 0 && !archive) {
    return null;
  }
  return { files, archive, totalBytes, truncated };
}
