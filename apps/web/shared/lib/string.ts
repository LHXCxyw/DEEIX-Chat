export function normalizeTrimmedString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalizedValue = value.trim();
  return normalizedValue || fallback;
}

// 历史或导入数据可能把用户存储目录（personal-<uuid>/年/月）或
// 个人渠道前缀（personal-<providerID>-）写进名称字段；展示时只保留文件名本身。
export function fileDisplayName(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/").trim().replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const base = segments.at(-1) || fileName;
  return base.replace(/^personal-[0-9a-f]{16,}-/i, "");
}
