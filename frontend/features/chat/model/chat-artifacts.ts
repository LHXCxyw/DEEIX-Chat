import type { ChatAreaMessage } from "@/features/chat/types/messages";
import { getBrandingSnapshot } from "@/shared/config/branding";
import {
  type ArtifactPreviewKind,
  resolveArtifactPreviewKind,
} from "@/shared/lib/artifact-preview";
import type { HTMLVisualThemeSnapshot } from "@/shared/lib/html-visual-theme";

export type { ArtifactPreviewKind } from "@/shared/lib/artifact-preview";

export type ChatArtifact = {
  id: string;
  messageID: string;
  messageKey: string;
  runID?: string;
  blockIndex: number;
  kind: ArtifactPreviewKind;
  language: string;
  code: string;
  complete: boolean;
  streaming: boolean;
  updatedAt?: string;
};

export type OpenCodeArtifactInput = {
  code: string;
  language: string;
  kind: ArtifactPreviewKind;
};

const SCRIPT_CLOSE_RE = /<\/script/gi;
const STYLE_CLOSE_RE = /<\/style/gi;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/;
// 以文档头开头的块一定是新文件，无论是否书写完整都不能拼进上一个 artifact
const NEW_DOC_START_RE = /^\s*(?:<!doctype\s+html[^>]*>|<html\b[^>]*>)/i;
const DOCTYPE_RE = /<!doctype\s+html[^>]*>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;
const HTML_CLOSE_RE = /<\/html\s*>/i;
const HEAD_BLOCK_RE = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i;
const BODY_BLOCK_RE = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const ARTIFACT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "connect-src 'none'",
  "manifest-src 'none'",
  "prefetch-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
].join("; ");

function parseFenceLanguage(info: string): string {
  const raw = info.trim().split(/\s+/)[0] ?? "";
  return raw.replace(/^\{?\.?/, "").replace(/\}?$/, "");
}

function artifactStableMessageID(
  message: Pick<ChatAreaMessage, "publicID" | "runID">,
): string {
  return message.runID?.trim() || message.publicID;
}

function isFenceClose(line: string, marker: string): boolean {
  const escaped = marker[0] === "`" ? "`" : "~";
  const re = new RegExp(`^[ \\t]*${escaped}{${marker.length},}[ \\t]*$`);
  return re.test(line);
}

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeScriptContent(value: string): string {
  return value.replace(SCRIPT_CLOSE_RE, "<\\/script");
}

function escapeStyleContent(value: string): string {
  return value.replace(STYLE_CLOSE_RE, "<\\/style");
}

function artifactRuntimeScript(): string {
  return `<script>
(() => {
  const formatError = (value) => {
    if (!value) return "Unknown preview error";
    if (value && value.stack) return String(value.stack);
    if (value && value.message) return String(value.message);
    return String(value);
  };
  const showError = (value) => {
    const message = formatError(value);
    const node = document.createElement("pre");
    node.textContent = message;
    node.style.cssText = "margin:16px;padding:12px;border:1px solid var(--destructive);border-radius:var(--radius);background:color-mix(in oklch,var(--destructive) 12%,var(--background));color:var(--destructive);font:12px/1.5 var(--font-mono);white-space:pre-wrap;";
    document.body.appendChild(node);
  };
  window.addEventListener("error", (event) => showError(event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => showError(event.reason));
})();
</script>`;
}

function artifactPreviewResetStyle(): string {
  return `<style data-deeix-artifact-reset>
html,
body {
  min-height: 100%;
  width: 100%;
  margin: 0;
}

body {
  overflow: auto;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}
</style>`;
}

function artifactThemeStyle(theme: HTMLVisualThemeSnapshot): string {
  const declarations = theme.variables.map(([name, value]) => `${name}:${value}`).join(";");
  return `<style data-deeix-artifact-theme>
:root { color-scheme: ${theme.colorScheme}; ${escapeStyleContent(declarations)} }
html, body { color: var(--foreground); background: var(--background); }
</style>`;
}

function previewHead(title: string, theme: HTMLVisualThemeSnapshot): string {
  return [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`,
    `<title>${escapeHTML(title)}</title>`,
    artifactThemeStyle(theme),
    artifactPreviewResetStyle(),
    artifactRuntimeScript(),
  ].join("");
}

function htmlPreviewDocument(code: string, theme: HTMLVisualThemeSnapshot): string {
  const safeHead = previewHead("Artifact Preview", theme);
  const userHead = HEAD_BLOCK_RE.exec(code)?.[1]?.trim() ?? "";
  const bodyMatch = BODY_BLOCK_RE.exec(code);
  const body = bodyMatch
    ? bodyMatch[1]
    : code
        .replace(DOCTYPE_RE, "")
        .replace(HTML_OPEN_RE, "")
        .replace(HTML_CLOSE_RE, "")
        .replace(HEAD_BLOCK_RE, "")
        .trim();

  return `<!doctype html><html><head>${safeHead}${userHead}</head><body>${body}</body></html>`;
}

function cssPreviewDocument(code: string, theme: HTMLVisualThemeSnapshot): string {
  const branding = getBrandingSnapshot();
  return `<!doctype html>
<html>
<head>
${previewHead("CSS Preview", theme)}
<style>${escapeStyleContent(code)}</style>
</head>
<body>
  <main class="artifact-preview">
    <section class="preview-panel">
      <p class="eyebrow">${escapeHTML(branding.shortName)} Artifact</p>
      <h1>Preview Surface</h1>
      <p>Generated CSS is applied to this isolated document.</p>
      <div class="preview-row">
        <button type="button">Primary action</button>
        <button type="button" class="secondary">Secondary</button>
      </div>
      <div class="preview-grid">
        <article><strong>Card</strong><span>Sample content</span></article>
        <article><strong>Metric</strong><span>128</span></article>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function javascriptPreviewDocument(code: string, theme: HTMLVisualThemeSnapshot): string {
  return `<!doctype html>
<html>
<head>
${previewHead("JavaScript Preview", theme)}
<style>
body { margin: 0; font: 14px/1.5 var(--font-sans); color: var(--foreground); background: var(--background); }
#root { min-height: 100vh; padding: 20px; box-sizing: border-box; }
.artifact-console { position: fixed; inset-inline: 12px; bottom: 12px; max-height: 32vh; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--muted); color: var(--muted-foreground); padding: 10px; font: 12px/1.5 var(--font-mono); white-space: pre-wrap; }
</style>
</head>
<body>
<div id="root"></div>
<pre id="console" class="artifact-console" hidden></pre>
<script>
(() => {
  const consoleNode = document.getElementById("console");
  const write = (level, values) => {
    consoleNode.hidden = false;
    consoleNode.textContent += "[" + level + "] " + values.map((item) => {
      try { return typeof item === "string" ? item : JSON.stringify(item); }
      catch { return String(item); }
    }).join(" ") + "\\n";
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      write(level, values);
      original(...values);
    };
  }
})();
</script>
<script>${escapeScriptContent(code)}</script>
</body>
</html>`;
}

export function buildArtifactPreviewDocument(
  kind: Exclude<ArtifactPreviewKind, "svg">,
  code: string,
  theme: HTMLVisualThemeSnapshot,
): string {
  if (kind === "css") return cssPreviewDocument(code, theme);
  if (kind === "javascript") return javascriptPreviewDocument(code, theme);
  return htmlPreviewDocument(code, theme);
}

export function resolveArtifactDownloadName(kind: ArtifactPreviewKind): string {
  if (kind === "css") return "artifact-css-preview.html";
  if (kind === "javascript") return "artifact-js-preview.html";
  if (kind === "svg") return "artifact.svg";
  return "artifact-preview.html";
}

type RawCodeBlock = {
  language: string;
  code: string;
  complete: boolean;
};

function extractRawCodeBlocks(
  message: Pick<ChatAreaMessage, "content">,
  resumeLanguage?: string,
): RawCodeBlock[] {
  const blocks: RawCodeBlock[] = [];
  const lines = message.content.split(/\r?\n/);
  let openMarker = "";
  let language = "";
  let codeLines: string[] = [];

  // resumeLanguage 表示上一条消息的中断围栏跨消息续接：本消息以裸围栏闭合该块后继续扫描
  if (resumeLanguage !== undefined) {
    openMarker = "```";
    language = resumeLanguage;
  }

  for (const line of lines) {
    if (!openMarker) {
      const openMatch = line.match(FENCE_OPEN_RE);
      if (!openMatch) {
        continue;
      }
      openMarker = openMatch[1] ?? "";
      language = parseFenceLanguage(openMatch[2] ?? "");
      codeLines = [];
      continue;
    }

    if (isFenceClose(line, openMarker)) {
      blocks.push({ language, code: codeLines.join("\n"), complete: true });
      openMarker = "";
      language = "";
      codeLines = [];
      continue;
    }

    codeLines.push(line);
  }

  // 未闭合的围栏即使消息已结束也要保留：说明生成被中断，后续消息可能是同一文件的续写
  if (openMarker) {
    blocks.push({ language, code: codeLines.join("\n"), complete: false });
  }

  return blocks;
}

export function extractArtifactsFromContent(
  message: Pick<ChatAreaMessage, "content" | "isStreaming" | "key" | "publicID" | "runID" | "updatedAt">,
): ChatArtifact[] {
  const stableMessageID = artifactStableMessageID(message);
  const runID = message.runID?.trim() || undefined;
  const streaming = Boolean(message.isStreaming);
  const artifacts: ChatArtifact[] = [];
  let blockIndex = 0;

  for (const block of extractRawCodeBlocks(message)) {
    const kind = resolveArtifactPreviewKind(block.language, block.code);
    if (!kind || !block.code.trim()) {
      continue;
    }
    artifacts.push({
      id: `${stableMessageID}:artifact:${blockIndex}`,
      messageID: message.publicID,
      messageKey: message.key,
      runID,
      blockIndex,
      kind,
      language: block.language,
      code: block.code,
      complete: block.complete,
      streaming,
      updatedAt: message.updatedAt,
    });
    blockIndex += 1;
  }

  if (artifacts.length === 0) {
    const kind = resolveArtifactPreviewKind("", message.content);
    if (kind && message.content.trim()) {
      const htmlTruncated = kind === "html" && !HTML_CLOSE_RE.test(message.content);
      artifacts.push({
        id: `${stableMessageID}:artifact:0`,
        messageID: message.publicID,
        messageKey: message.key,
        runID,
        blockIndex: 0,
        kind,
        language: kind,
        code: message.content,
        complete: !streaming && !htmlTruncated,
        streaming,
        updatedAt: message.updatedAt,
      });
    }
  }

  return artifacts;
}

function canMergeRawBlock(previous: ChatArtifact, block: RawCodeBlock): boolean {
  if (previous.kind !== "html") {
    // 非 HTML 类型无法从内容区分"续写"与"新文件"，仅在续写片段本身仍不完整时合并
    return (
      resolveArtifactPreviewKind(block.language, block.code) === previous.kind && !block.complete
    );
  }
  if (block.language) {
    const kind = resolveArtifactPreviewKind(block.language, block.code);
    if (kind !== "html") return false;
  }
  // 续写块重新生成了完整文档（自带文档头）时视为新文件，不合并
  if (NEW_DOC_START_RE.test(block.code)) {
    return false;
  }
  return true;
}

function appendBlock(
  merged: ChatArtifact,
  block: RawCodeBlock,
  message: Pick<ChatAreaMessage, "publicID" | "key" | "runID" | "updatedAt">,
  streaming: boolean,
): ChatArtifact {
  const code = `${merged.code}\n${block.code}`;
  const language = merged.language || block.language;
  const kind = resolveArtifactPreviewKind(language, code) ?? merged.kind;
  return {
    id: `${merged.id}:merged`,
    messageID: message.publicID,
    messageKey: message.key,
    runID: message.runID?.trim() || undefined,
    blockIndex: merged.blockIndex,
    kind,
    language,
    code,
    complete: block.complete,
    streaming,
    updatedAt: message.updatedAt,
  };
}

function isContinuationFragment(previous: ChatArtifact, block: RawCodeBlock): boolean {
  if (NEW_DOC_START_RE.test(block.code)) {
    return false;
  }
  if (previous.kind !== "html") {
    return resolveArtifactPreviewKind(block.language, block.code) === previous.kind && !block.complete;
  }
  if (block.language && resolveArtifactPreviewKind(block.language, block.code) !== "html") {
    return false;
  }
  return true;
}

export function extractArtifactsFromMessages(messages: ChatAreaMessage[]): ChatArtifact[] {
  const artifacts: ChatArtifact[] = [];
  // pending 指向一段未写完的 artifact（生成被中断）；若后续 assistant 消息是同一文件的
  // 续写（以裸围栏闭合上一条的中断块，或其代码块是延续片段而非重新生成的完整文档），
  // 则拼接为同一个 artifact
  let pending: ChatArtifact | null = null;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const streaming = Boolean(message.isStreaming);
    const stableMessageID = artifactStableMessageID(message);
    let messageBlockIndex = 0;
    // 续接模式下，本消息中属于同一续篇的后续片段也拼进同一 artifact
    let resumeArtifact: ChatArtifact | null = null;

    const handleBlock = (block: RawCodeBlock, resumed: boolean) => {
      const target = resumed
        ? pending
        : resumeArtifact && isContinuationFragment(resumeArtifact, block)
          ? resumeArtifact
          : pending && canMergeRawBlock(pending, block)
            ? pending
            : null;
      if (target) {
        const merged = appendBlock(target, block, message, streaming);
        artifacts[artifacts.length - 1] = merged;
        if (resumed || resumeArtifact) {
          resumeArtifact = merged;
        }
        pending = merged.complete ? null : merged;
        return;
      }
      resumeArtifact = null;
      pending = null;

      const kind = resolveArtifactPreviewKind(block.language, block.code);
      if (!kind || !block.code.trim()) {
        return;
      }
      const artifact: ChatArtifact = {
        id: `${stableMessageID}:artifact:${messageBlockIndex}`,
        messageID: message.publicID,
        messageKey: message.key,
        runID: message.runID?.trim() || undefined,
        blockIndex: messageBlockIndex,
        kind,
        language: block.language,
        code: block.code,
        complete: block.complete,
        streaming,
        updatedAt: message.updatedAt,
      };
      messageBlockIndex += 1;
      artifacts.push(artifact);
      if (!block.complete) {
        pending = artifact;
      }
    };

    // 续接模式：pending 未完成且本消息以裸围栏开头，视为闭合上一条的中断块并继续。
    // 只有第一个块是中断块的续篇，其余块仍是独立代码块
    const firstLine = message.content.split(/\r?\n/).find((line) => line.trim()) ?? "";
    const firstOpen = firstLine.match(FENCE_OPEN_RE);
    if (pending && firstOpen && !parseFenceLanguage(firstOpen[2] ?? "")) {
      const blocks = extractRawCodeBlocks(message, pending.language);
      if (blocks.length === 0) {
        continue;
      }
      handleBlock(blocks[0], true);
      for (const block of blocks.slice(1)) {
        handleBlock(block, false);
      }
      continue;
    }

    const rawBlocks = extractRawCodeBlocks(message);
    for (const block of rawBlocks) {
      handleBlock(block, false);
    }

    if (rawBlocks.length === 0) {
      for (const artifact of extractArtifactsFromContent(message)) {
        artifacts.push(artifact);
        if (!artifact.complete) {
          pending = artifact;
        }
      }
    }
  }

  return artifacts;
}
