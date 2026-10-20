import type { ChatAreaMessage } from "@/features/chat/types/messages";
import { diffLines } from "@/shared/lib/line-diff";

// 项目文件工具名：工具调用分类与结果解析共用同一份清单，避免各处重复枚举。
export const PROJECT_FILE_TOOL_NAMES = new Set([
  "project_list_files",
  "project_read_file",
  "project_search_files",
  "project_write_file",
  "project_patch_file",
  "project_delete_file",
  "project_create_archive",
  "project_show_diff",
  "project_preview",
]);

export type ProjectFileAction = "read" | "search" | "create" | "modify" | "delete" | "diff";

// 单次项目工具调用解析出的文件动作，用于聊天里工具步骤的行内展示。
export type ProjectFileEntry = {
  key: string;
  action: ProjectFileAction;
  path: string;
  before?: string;
  after?: string;
  title?: string;
  query?: string;
  diffUnavailable?: "missing" | "truncated";
};

// 工具调用载荷：仅取解析所需字段，兼容 trace 工具调用的结构。
export type ProjectToolCallPayload = {
  file_diff?: unknown;
  status?: string;
  name?: string;
  input?: string;
  input_preview?: string;
  input_detail?: string;
  output?: string;
  output_text?: string;
  output_preview?: string;
  output_detail?: string;
};

export type ProjectChange = {
  key: string;
  messageKey: string;
  round: string;
  name: string;
  path: string;
  oldContent?: string;
  newContent?: string;
  // 合并条目保留的原子变更序列（同轮同文件多次修改），用于重建初始内容。
  parts?: ProjectChange[];
};

// 单轮对话产生的变更分组。
export type ProjectChangeGroup = {
  messageKey: string;
  title: string;
  time: string;
  changes: ProjectChange[];
};

// 变更事件来源的最小结构：优先使用 processTrace.events，回退到 tools 汇总块。
type TraceSource = { eventID?: string; roundID?: string; payloadJson?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    // Type assertion: typeof 与 Array.isArray 已把值收窄为普通对象。
    return value as Record<string, unknown>;
  }
  return null;
}

export function parseRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) {
    return direct;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return parseRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function stringValue(record: Record<string, unknown> | null, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof record?.[key] === "string") {
      // Type assertion: typeof 判定后该键确为字符串。
      return record[key] as string;
    }
  }
  return "";
}

// 依次解析候选载荷，返回首个成功解析的原始值（可为数组，用于列表类结果）。
function readCallPayload(...values: Array<string | undefined>): unknown {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    try {
      return JSON.parse(value);
    } catch {
      // 截断的 JSON 无法解析，尝试下一个候选。
    }
  }
  return null;
}

function readCallRecord(...values: Array<string | undefined>): Record<string, unknown> | null {
  for (const value of values) {
    const record = parseRecord(value);
    if (record) {
      return record;
    }
  }
  return null;
}

// 从项目文件记录里取相对路径：后端 Go 结构体按 PascalCase 序列化。
function filePath(value: unknown): string {
  return stringValue(asRecord(value), "RelativePath", "relative_path", "path", "file");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

// 把单次项目工具调用解析为可展示的文件动作条目。
export function projectFileEntries(call: ProjectToolCallPayload, keyPrefix = ""): ProjectFileEntry[] {
  const name = (call.name || "").trim();
  if (!PROJECT_FILE_TOOL_NAMES.has(name)) {
    return [];
  }
  const input = readCallRecord(call.input_detail, call.input_preview, call.input);
  const output = readCallPayload(call.output_detail, call.output, call.output_text, call.output_preview);
  const entries: ProjectFileEntry[] = [];
  const push = (entry: Omit<ProjectFileEntry, "key">) => {
    entries.push({ ...entry, key: `${keyPrefix}${name}:${entries.length}` });
  };

  switch (name) {
    case "project_read_file": {
      const outputRecord = asRecord(output);
      const path = filePath(outputRecord?.file) || filePath(outputRecord) || stringValue(input, "file");
      if (path) {
        push({ action: "read", path });
      }
      break;
    }
    case "project_list_files": {
      const list = Array.isArray(output) ? output : [];
      for (const path of uniqueStrings(list.map(filePath).filter(Boolean))) {
        push({ action: "read", path });
      }
      break;
    }
    case "project_search_files": {
      const query = stringValue(input, "query");
      const list = Array.isArray(output) ? output : [];
      const paths = uniqueStrings(list.map((item) => filePath(asRecord(item)?.file) || filePath(item)).filter(Boolean));
      if (paths.length === 0) {
        push({ action: "search", path: "", query });
      } else {
        for (const path of paths) {
          push({ action: "search", path, query });
        }
      }
      break;
    }
    case "project_write_file":
    case "project_patch_file": {
      const snapshot = asRecord(call.file_diff) || asRecord(asRecord(output)?.file_diff);
      const path = stringValue(snapshot, "path") || filePath(asRecord(output)?.file) || filePath(output) || stringValue(input, "path", "file");
      const available = snapshot && snapshot.truncated === false && typeof snapshot.before === "string" && typeof snapshot.after === "string";
      const failed = call.status === "error" || call.status === "failed";
      push({
        action: snapshot?.created === true ? "create" : "modify",
        path,
        before: available && !failed ? stringValue(snapshot, "before") : undefined,
        after: available && !failed ? stringValue(snapshot, "after") : undefined,
        diffUnavailable: !available || failed ? snapshot?.truncated === true ? "truncated" : "missing" : undefined,
      });
      break;
    }
    case "project_delete_file": {
      const outputRecord = asRecord(output);
      const deleted = Array.isArray(outputRecord?.files) ? outputRecord.files : [];
      const paths = uniqueStrings(deleted.map(filePath).filter(Boolean));
      if (paths.length > 0) {
        for (const path of paths) {
          push({ action: "delete", path });
        }
      } else {
        const path = filePath(outputRecord) || stringValue(input, "file", "path");
        if (path) {
          push({ action: "delete", path });
        }
      }
      break;
    }
    case "project_create_archive": {
      // 归档结果没有具体文件路径，交由通用结果展示。
      break;
    }
    case "project_show_diff": {
      const outputRecord = asRecord(output);
      const path = stringValue(outputRecord, "path") || stringValue(input, "path", "file");
      push({
        action: "diff",
        path,
        before: stringValue(outputRecord, "before") || stringValue(input, "before"),
        after: stringValue(outputRecord, "after") || stringValue(input, "after"),
        title: stringValue(outputRecord, "title") || stringValue(input, "title"),
      });
      break;
    }
    case "project_preview": {
      const path = filePath(output) || stringValue(input, "file", "path");
      if (path) {
        push({ action: "read", path });
      }
      break;
    }
    default:
      break;
  }
  return entries;
}

// 仅完整快照可生成统计，未知历史不伪装为零差异。
export function projectFileDiffStat(entry: ProjectFileEntry): { added: number; removed: number } | null {
  if (entry.after === undefined || entry.before === undefined || entry.diffUnavailable) {
    return null;
  }
  let added = 0;
  let removed = 0;
  for (const line of diffLines(entry.before, entry.after)) {
    if (line.kind === "added") {
      added += 1;
    } else if (line.kind === "removed") {
      removed += 1;
    }
  }
  return { added, removed };
}

function traceSources(message: ChatAreaMessage): TraceSource[] {
  const events = message.processTrace?.events ?? [];
  if (events.length > 0) {
    return events;
  }
  const tools = message.processTrace?.tools;
  if (tools) {
    return [{ roundID: tools.roundID, payloadJson: tools.payloadJson }];
  }
  return [];
}

export function projectChanges(messages: ChatAreaMessage[]): ProjectChange[] {
  return projectChangeGroups(messages).flatMap((group) => group.changes);
}

// 按消息（对话轮次）聚合变更：每个分组对应一次用户请求引发的 AI 修改批次。
// 分组标题优先取该助手消息对应的用户提示词（父消息），回退到助手消息自身文本。
export function projectChangeGroups(messages: ChatAreaMessage[]): ProjectChangeGroup[] {
  const byPublicID = new Map(messages.map((message) => [message.publicID, message]));
  const groups: ProjectChangeGroup[] = [];
  const plainText = (raw: string) => raw.replace(/\s+/g, " ").trim();
  for (const message of messages) {
    const sources = traceSources(message);
    const changes: ProjectChange[] = [];
    for (const [sourceIndex, event] of sources.entries()) {
      const payload = parseRecord(event.payloadJson);
      const calls = Array.isArray(payload?.tool_calls) ? payload.tool_calls : [];
      const eventKey = event.eventID ?? `${message.key}-${sourceIndex}`;
      calls.forEach((raw, index) => {
        const call = parseRecord(raw);
        const name = stringValue(call, "name");
        if (name === "project_create_archive") {
          changes.push({
            key: `${message.key}-${eventKey}-${index}`,
            messageKey: message.key,
            round: event.roundID || `Round ${index + 1}`,
            name,
            path: "",
          });
          return;
        }
        if (!["project_write_file", "project_patch_file", "project_delete_file"].includes(name)) {
          return;
        }
        const input = parseRecord(stringValue(call, "input_detail", "input_preview", "input"));
        const path = stringValue(input, "path", "file");
        if (!path) {
          return;
        }
        // patch 的多片段模式：每个片段生成独立的变更条目，便于逐段查看 Diff。
        if (name === "project_patch_file" && Array.isArray(input?.patches) && input.patches.length > 0) {
          input.patches.forEach((patchRaw, patchIndex) => {
            const patch = parseRecord(patchRaw);
            if (!patch) {
              return;
            }
            changes.push({
              key: `${message.key}-${eventKey}-${index}-${patchIndex}`,
              messageKey: message.key,
              round: event.roundID || `Round ${index + 1}`,
              name,
              path,
              oldContent: stringValue(patch, "old"),
              newContent: stringValue(patch, "new"),
            });
          });
          return;
        }
        changes.push({
          key: `${message.key}-${eventKey}-${index}`,
          messageKey: message.key,
          round: event.roundID || `Round ${index + 1}`,
          name,
          path,
          oldContent: name === "project_patch_file" ? stringValue(input, "old") : name === "project_write_file" ? "" : undefined,
          newContent:
            name === "project_patch_file" ? stringValue(input, "new") : name === "project_write_file" ? stringValue(input, "content") : undefined,
        });
      });
    }
    if (changes.length > 0) {
      const parent = message.parentPublicID ? byPublicID.get(message.parentPublicID) : undefined;
      const title = plainText(parent && parent.role === "user" ? parent.content : message.content) || `Round ${groups.length + 1}`;
      const shown = title.length > 40 ? `${title.slice(0, 40)}…` : title;
      groups.push({
        messageKey: message.key,
        title: shown,
        time: message.createdAt ?? "",
        changes: mergeChangesByPath(changes),
      });
    }
  }
  return groups;
}

// 同一轮内对同一文件的多次修改（含多片段补丁）合并为一条：按首次出现位置展示，parts 保留原子序列。
function mergeChangesByPath(changes: ProjectChange[]): ProjectChange[] {
  if (changes.length < 2) {
    return changes;
  }
  const buckets = new Map<string, ProjectChange[]>();
  let hasDuplicate = false;
  for (const change of changes) {
    if (change.name === "project_create_archive") {
      continue;
    }
    const bucket = buckets.get(change.path);
    if (bucket) {
      bucket.push(change);
      hasDuplicate = true;
    } else {
      buckets.set(change.path, [change]);
    }
  }
  if (!hasDuplicate) {
    return changes;
  }
  const merged: ProjectChange[] = [];
  const emitted = new Set<string>();
  for (const change of changes) {
    if (change.name === "project_create_archive") {
      merged.push(change);
      continue;
    }
    if (emitted.has(change.path)) {
      continue;
    }
    emitted.add(change.path);
    const parts = buckets.get(change.path) ?? [change];
    if (parts.length === 1) {
      merged.push(change);
      continue;
    }
    const first = parts[0];
    const last = parts[parts.length - 1];
    merged.push({
      key: `${first.messageKey}:${first.path}`,
      messageKey: first.messageKey,
      round: first.round,
      // 最终操作决定展示状态（以删除结尾显示删除态）。
      name: last.name,
      path: first.path,
      oldContent: first.name === "project_write_file" ? "" : first.oldContent,
      newContent: last.newContent,
      parts,
    });
  }
  return merged;
}

// 收集整个对话中对指定路径的全部原子变更（跨轮次、按时间序），用于累计 Diff。
export function collectProjectFileChanges(messages: ChatAreaMessage[], path: string): ProjectChange[] {
  if (!path) {
    return [];
  }
  return projectChangeGroups(messages)
    .flatMap((group) => group.changes)
    .filter((change) => change.path === path && change.name !== "project_create_archive")
    .flatMap((change) => change.parts ?? [change]);
}

// 逆序还原补丁，重建文件在某批变更之前的初始内容；出现全量 write 时其之前的历史已被覆盖，以空内容为基准。
export function reconstructProjectFileInitial(final: string, parts: ProjectChange[]): string {
  let lastWriteIndex = -1;
  parts.forEach((part, index) => {
    if (part.name === "project_write_file") {
      lastWriteIndex = index;
    }
  });
  if (lastWriteIndex >= 0) {
    return "";
  }
  let content = final;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.name !== "project_patch_file") {
      continue;
    }
    // 空 new（片段被移除）无法定位还原位置，跳过该片段。
    if (!part.newContent || part.oldContent === undefined || part.oldContent === null) {
      continue;
    }
    // 用函数形式替换，避免 oldContent 中的 $& 等模式被当作替换模式解释。
    // Type assertion: 上方已排除 undefined/null，oldContent 为字符串。
    const replaced = content.replace(part.newContent, () => part.oldContent as string);
    if (replaced !== content) {
      content = replaced;
    }
  }
  return content;
}
