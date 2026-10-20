import type { HTMLVisualThemeSnapshot } from "@/shared/lib/html-visual-theme";
import { type SandboxDocumentOptions, sandboxDocumentHead } from "@/shared/lib/sandbox-document";

// 项目预览文档构建器：把项目内的 HTML/SVG 入口与其相对引用的资源（CSS/JS/图片/字体）
// 内联为可在沙箱 iframe 中渲染的完整文档。取数通过 PreviewFileSource 注入，工作区
// （登录态端点）与分享页（公开端点）各自实现，本模块只负责路径解析、资源内联与沙箱包裹。

// 预览取数回调：按相对路径列出文件、读取文本与读取二进制资源（data URL）。
export type PreviewFileSource = {
  listFiles: () => Promise<{ path: string; mimeType: string }[]>;
  readText: (path: string) => Promise<string | null>;
  readDataUrl: (path: string) => Promise<string | null>;
};

// 可预览渲染的文件类型：HTML/SVG 在沙箱 iframe 中实时渲染。
export function isPreviewableFile(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ["html", "htm", "svg"].includes(extension);
}

// 预览资源内联：把 HTML 中相对引用的工作区文件拉取后内联进沙箱预览文档。
const EXTERNAL_REF_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function isExternalRef(ref: string): boolean {
  return EXTERNAL_REF_PATTERN.test(ref.trim());
}

// 模板占位符（${x}、{{x}}、<%x%>）说明引用是运行时动态拼接的，无法静态解析，也不算缺失资源。
function isDynamicRef(ref: string): boolean {
  return ref.includes("${") || ref.includes("{{") || ref.includes("<%");
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

// 规范化工作区相对路径：以 HTML 所在目录为基准解析 ./ 与 ../，前导 / 视为项目根。
function resolveWorkspacePath(baseDir: string, ref: string): string {
  const cleaned = ref.trim().split(/[?#]/)[0];
  const segments = (cleaned.startsWith("/") ? cleaned.slice(1) : `${baseDir ? `${baseDir}/` : ""}${cleaned}`).split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.join("/");
}

const BINARY_ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
]);

export function isBinaryAssetPath(path: string): boolean {
  return BINARY_ASSET_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // Type assertion: FileReader.result 的类型是 string | ArrayBuffer | null，
    // readAsDataURL 成功后必为 string，但该 DOM API 无类型守卫可据此收窄。
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

// 提取 HTML 标签字符串中的属性值（src/href/rel 等简单属性）。
function extractAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) {
    return null;
  }
  return (match[1] ?? match[2] ?? match[3] ?? "").trim() || null;
}

function removeAttr(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"), "");
}

// 异步正则替换：并发执行替换函数但保持匹配顺序，避免结果乱序。
async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(pattern)];
  if (matches.length === 0) {
    return input;
  }
  const replacements = await Promise.all(matches.map((match) => replacer(match[0], ...match.slice(1))));
  let result = "";
  let lastIndex = 0;
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    result += input.slice(lastIndex, start) + replacements[index];
    lastIndex = start + match[0].length;
  });
  return result + input.slice(lastIndex);
}

const DOCTYPE_RE = /<!doctype\s+html[^>]*>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;
const HTML_CLOSE_RE = /<\/html\s*>/i;
const HEAD_BLOCK_RE = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i;
const BODY_BLOCK_RE = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;

// 把内联后的页面包进严格 CSP 沙箱文档：复用上游沙箱头（主题变量 + 重置样式 + 错误兜底）。
export function buildSandboxPreviewDocument(
  path: string,
  inlined: string,
  theme: HTMLVisualThemeSnapshot,
  options?: SandboxDocumentOptions,
): string {
  const title = path.split("/").at(-1) ?? path;
  const head = sandboxDocumentHead(title, theme, options);
  if (path.toLowerCase().endsWith(".svg")) {
    return `<!doctype html><html><head>${head}</head><body>${inlined}</body></html>`;
  }
  const userHead = HEAD_BLOCK_RE.exec(inlined)?.[1]?.trim() ?? "";
  const bodyMatch = BODY_BLOCK_RE.exec(inlined);
  const body = bodyMatch
    ? bodyMatch[1]
    : inlined
        .replace(DOCTYPE_RE, "")
        .replace(HTML_OPEN_RE, "")
        .replace(HTML_CLOSE_RE, "")
        .replace(HEAD_BLOCK_RE, "")
        .trim();
  return `<!doctype html><html><head>${head}${userHead}</head><body>${body}</body></html>`;
}

// CSS 文本处理：@import 递归内联（限两层），url() 引用转为 data URL。
async function inlineCss(css: string, baseDir: string, depth: number, source: PreviewFileSource): Promise<string> {
  let result = css;
  if (depth < 3) {
    result = await replaceAsync(
      result,
      /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi,
      async (statement, ref) => {
        if (isExternalRef(ref) || !ref.toLowerCase().endsWith(".css")) {
          return statement;
        }
        const resolved = resolveWorkspacePath(baseDir, ref);
        const text = await source.readText(resolved);
        if (text === null) {
          return statement;
        }
        return await inlineCss(text, directoryOf(resolved), depth + 1, source);
      },
    );
  }
  result = await replaceAsync(result, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (reference, _quote, ref) => {
    if (isExternalRef(ref) || ref.startsWith("data:") || isDynamicRef(ref)) {
      return reference;
    }
    const dataUrl = await source.readDataUrl(resolveWorkspacePath(baseDir, ref));
    return dataUrl ? `url("${dataUrl}")` : reference;
  });
  return result;
}

// 构建内联预览文档：link/script/img 与 style 块的相对引用全部解析为工作区资源，
// 最后包进严格 CSP 沙箱文档。
export async function buildPreviewDocument(
  content: string,
  entryPath: string,
  source: PreviewFileSource,
  theme: HTMLVisualThemeSnapshot,
  options?: SandboxDocumentOptions,
): Promise<{ doc: string; missing: string[] }> {
  const baseDir = directoryOf(entryPath);
  const missing: string[] = [];
  let doc = content;
  doc = await replaceAsync(doc, /<link\b[^>]*>/gi, async (tag) => {
    const rel = extractAttr(tag, "rel") ?? "";
    if (!/stylesheet/i.test(rel)) {
      return tag;
    }
    const href = extractAttr(tag, "href");
    if (!href || isExternalRef(href) || isDynamicRef(href)) {
      return tag;
    }
    const resolved = resolveWorkspacePath(baseDir, href);
    const text = await source.readText(resolved);
    if (text === null) {
      missing.push(href);
      return tag;
    }
    return `<style>\n${await inlineCss(text, directoryOf(resolved), 1, source)}\n</style>`;
  });
  doc = await replaceAsync(doc, /<script\b([^>]*)>\s*<\/script>/gi, async (full, attrs) => {
    const src = extractAttr(full, "src");
    if (!src || isExternalRef(src) || isDynamicRef(src)) {
      return full;
    }
    const resolved = resolveWorkspacePath(baseDir, src);
    const text = await source.readText(resolved);
    if (text === null) {
      missing.push(src);
      return full;
    }
    return `<script${removeAttr(` ${attrs}`, "src").trimEnd()}>\n${text}\n</script>`;
  });
  doc = await replaceAsync(doc, /<img\b[^>]*>/gi, async (tag) => {
    const src = extractAttr(tag, "src");
    if (!src || isExternalRef(src) || isDynamicRef(src)) {
      return tag;
    }
    const dataUrl = await source.readDataUrl(resolveWorkspacePath(baseDir, src));
    if (!dataUrl) {
      missing.push(src);
      return tag;
    }
    return tag.replace(src, dataUrl);
  });
  doc = await replaceAsync(
    doc,
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    async (_full, open, css, close) => `${open}\n${await inlineCss(css, baseDir, 1, source)}\n${close}`,
  );
  return { doc: buildSandboxPreviewDocument(entryPath, doc, theme, options), missing };
}
