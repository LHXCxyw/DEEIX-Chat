const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*`?([^`\s)]+)`?\s*\)/i;
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;
const HTTP_IMAGE_URL_RE = /https?:\/\/[^\s`<>"')]+/i;
const RAW_BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;
const MIN_RAW_BASE64_LENGTH = 64;

const BASE64_MIME_PREFIXES = [
  { prefix: "iVBORw0", mimeType: "image/png", extension: "png" },
  { prefix: "/9j/", mimeType: "image/jpeg", extension: "jpg" },
  { prefix: "R0lGOD", mimeType: "image/gif", extension: "gif" },
  { prefix: "UklGR", mimeType: "image/webp", extension: "webp" },
] as const;

export type CanvasChatImageSource =
  | { kind: "url"; source: string }
  | { kind: "base64"; payload: string; mimeType: string; extension: string };

function normalizeBase64(value: string): string {
  return value.replace(/\s/g, "");
}

function resolveBase64Source(value: string): CanvasChatImageSource | null {
  const dataMatch = DATA_IMAGE_RE.exec(value.trim());
  if (dataMatch) {
    const mimeType = dataMatch[1].toLowerCase().replace("image/jpg", "image/jpeg");
    const payload = normalizeBase64(dataMatch[2]);
    if (payload.length < MIN_RAW_BASE64_LENGTH || !RAW_BASE64_RE.test(payload)) {
      return null;
    }
    return {
      kind: "base64",
      payload,
      mimeType,
      extension: mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length),
    };
  }

  const payload = normalizeBase64(value);
  if (payload.length < MIN_RAW_BASE64_LENGTH || !RAW_BASE64_RE.test(payload)) {
    return null;
  }
  const detected = BASE64_MIME_PREFIXES.find((item) => payload.startsWith(item.prefix));
  return detected
    ? { kind: "base64", payload, mimeType: detected.mimeType, extension: detected.extension }
    : null;
}

/** 从 Chat 模型文本响应中提取 Markdown 图片、裸 URL、Data URL 或裸图片 Base64。 */
export function resolveCanvasChatImageSource(content: string): CanvasChatImageSource | null {
  const text = content.trim();
  if (!text) {
    return null;
  }

  const markdownSource = MARKDOWN_IMAGE_RE.exec(text)?.[1]?.trim();
  if (markdownSource) {
    if (/^https?:\/\//i.test(markdownSource)) {
      return { kind: "url", source: markdownSource };
    }
    const base64 = resolveBase64Source(markdownSource);
    if (base64) {
      return base64;
    }
  }

  const directBase64 = resolveBase64Source(text);
  if (directBase64) {
    return directBase64;
  }

  const url = HTTP_IMAGE_URL_RE.exec(text)?.[0];
  return url ? { kind: "url", source: url } : null;
}

function decodeBase64(payload: string): ArrayBuffer {
  const binary = window.atob(payload);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function extensionFromMIME(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

export async function canvasChatImageSourceToFile(
  source: CanvasChatImageSource,
  signal: AbortSignal,
): Promise<File> {
  if (source.kind === "base64") {
    const bytes = decodeBase64(source.payload);
    return new File([bytes], `canvas-chat-image.${source.extension}`, { type: source.mimeType });
  }

  const response = await fetch(source.source, { signal });
  if (!response.ok) {
    throw new Error(`图片下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const mimeType = (response.headers.get("content-type") || blob.type).split(";")[0].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error(`响应不是图片（${mimeType || "未知类型"}）`);
  }
  let fileName = "canvas-chat-image";
  try {
    const pathName = new URL(source.source).pathname.split("/").filter(Boolean).at(-1) || "";
    fileName = pathName && pathName.includes(".") ? pathName : `${fileName}.${extensionFromMIME(mimeType)}`;
  } catch {
    fileName = `${fileName}.${extensionFromMIME(mimeType)}`;
  }
  return new File([blob], fileName, { type: mimeType });
}
