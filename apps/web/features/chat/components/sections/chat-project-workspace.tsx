"use client";

import {
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileArchive,
  FileCode2,
  FileDiff,
  FilePlus2,
  Folder,
  FolderArchive,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import type { ChatAreaMessage } from "@/features/chat/types/messages";
import { cn } from "@/lib/utils";
import { useLocalizedErrorMessage } from "@/i18n/use-localized-error";
import { ApiError } from "@/shared/api/http-client";
import {
  deleteProjectFile,
  downloadProjectArchive,
  fetchProjectFileBlob,
  fetchProjectFileContent,
  getProjectWorkspace,
  saveProjectFile,
  uploadProjectArchive,
} from "@/shared/api/conversation";
import type { ProjectWorkspaceFileDTO } from "@/shared/api/conversation-types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { useTheme } from "@/shared/components/theme-provider";
import type {
  ProjectCodeEditorController,
  ProjectCodeEditorTheme,
} from "@/shared/components/project-code-editor-runtime";
import {
  captureHTMLVisualThemeSnapshot,
  type HTMLVisualThemeSnapshot,
} from "@/shared/lib/html-visual-theme";
import { SANDBOX_IFRAME_PERMISSIONS, sandboxDocumentHead } from "@/shared/lib/sandbox-document";

type ProjectEditorRuntime = typeof import("@/shared/components/project-code-editor-runtime");

const PROJECT_TREE_HEIGHT_KEY = "deeix-chat:project-tree-height";
const EDITOR_WORD_WRAP_KEY = "deeix-chat:editor-word-wrap";
const BASE_EDITOR_FONT_SIZE = 12;

let projectEditorRuntimePromise: Promise<ProjectEditorRuntime> | null = null;

// 编辑器运行时为独立分块，多个工作区实例共享同一份代码。
function loadProjectEditorRuntime(): Promise<ProjectEditorRuntime> {
  projectEditorRuntimePromise ??= import("@/shared/components/project-code-editor-runtime").catch(
    (error: unknown) => {
      // 分块加载瞬时失败时允许下次挂载重试。
      projectEditorRuntimePromise = null;
      throw error;
    },
  );
  return projectEditorRuntimePromise;
}

function readUIFontScale(): number {
  if (typeof window === "undefined") {
    return 1;
  }
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale").trim();
  const scale = Number.parseFloat(raw);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// 判断拖入文件是否可按文本保存到项目工作区（二进制文件不适用文本写入端点）。
function isTextLikeFile(file: File): boolean {
  if (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    file.type === "application/yaml" ||
    file.type === "application/x-yaml" ||
    file.type === "application/toml"
  ) {
    return true;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return [
    "css",
    "go",
    "html",
    "java",
    "js",
    "json",
    "jsx",
    "md",
    "markdown",
    "mjs",
    "py",
    "rs",
    "scss",
    "sh",
    "sql",
    "svg",
    "ts",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
    "toml",
    "cjs",
  ].includes(extension);
}

// 工作区树节点：目录与文件统一渲染，支持折叠与多选。
type WorkspaceTreeNode =
  | { kind: "directory"; path: string; label: string; depth: number; count: number }
  | { kind: "file"; path: string; label: string; depth: number; file: ProjectWorkspaceFileDTO };

type DirectoryNode = {
  dirs: Map<string, DirectoryNode>;
  files: Map<string, ProjectWorkspaceFileDTO>;
  count: number;
};

// 递归构建文件树并按 DFS 展平：目录在文件之前、同级按名称排序，保证父子级紧邻排列。
function buildWorkspaceTree(files: ProjectWorkspaceFileDTO[], collapsed: Set<string>): WorkspaceTreeNode[] {
  const root: DirectoryNode = { dirs: new Map(), files: new Map(), count: 0 };
  for (const file of files) {
    if (file.EntryType !== "file") {
      continue;
    }
    const parts = file.RelativePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let current = root;
    current.count += 1;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = current.dirs.get(dirPath);
      if (!next) {
        next = { dirs: new Map(), files: new Map(), count: 0 };
        current.dirs.set(dirPath, next);
      }
      next.count += 1;
      current = next;
    }
    current.files.set(file.RelativePath, file);
  }
  const rows: WorkspaceTreeNode[] = [];
  const walk = (node: DirectoryNode, depth: number) => {
    const dirs = [...node.dirs.entries()].sort((left, right) => left[0].localeCompare(right[0]));
    const fileRows = [...node.files.values()].sort((left, right) => left.FileName.localeCompare(right.FileName));
    for (const [dirPath, dirNode] of dirs) {
      rows.push({
        kind: "directory",
        path: dirPath,
        label: dirPath.split("/").at(-1) ?? dirPath,
        depth,
        count: dirNode.count,
      });
      if (!collapsed.has(dirPath)) {
        walk(dirNode, depth + 1);
      }
    }
    for (const file of fileRows) {
      rows.push({ kind: "file", path: file.RelativePath, label: file.FileName, depth, file });
    }
  };
  walk(root, 0);
  return rows;
}

// 聊天区文件标签页的数据模型：path 为当前可编辑路径，fileID 为空表示尚未保存的新文件。
export type ProjectFileTab = {
  key: string;
  path: string;
  fileID: string;
  content: string;
  savedContent: string;
  diff: { old: string; next: string } | null;
  note: string;
  deleted: boolean;
};

// 可预览渲染的文件类型：HTML/SVG 在沙箱 iframe 中实时渲染。
function isPreviewableFile(path: string): boolean {
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

function isBinaryAssetPath(path: string): boolean {
  return BINARY_ASSET_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
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
function buildSandboxPreviewDocument(path: string, inlined: string, theme: HTMLVisualThemeSnapshot): string {
  const title = path.split("/").at(-1) ?? path;
  const head = sandboxDocumentHead(title, theme);
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

// 基于 CodeMirror 6 的编辑器：普通文件可编辑，Diff/删除态只读。
function ProjectCodeEditor({
  path,
  value,
  original,
  onChange,
}: {
  path: string;
  value: string;
  original?: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("chat.workspace");
  const tError = useLocalizedErrorMessage();
  const { resolvedTheme } = useTheme();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<ProjectCodeEditorController | null>(null);
  const onChangeRef = React.useRef(onChange);
  const valueRef = React.useRef(value);
  const labelsRef = React.useRef({ t, tError });
  const isDiff = original !== undefined;
  const theme: ProjectCodeEditorTheme = resolvedTheme === "dark" ? "dark" : "light";
  // 自动换行为全局偏好：所有编辑器标签共享，持久化到 localStorage。
  const [wordWrap, setWordWrap] = React.useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(EDITOR_WORD_WRAP_KEY) === "true",
  );

  React.useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
    labelsRef.current = { t, tError };
  });

  React.useEffect(() => {
    let disposed = false;
    loadProjectEditorRuntime()
      .then(({ createProjectCodeEditor }) => {
        const parent = containerRef.current;
        if (disposed || !parent) {
          return;
        }
        const editor = createProjectCodeEditor({
          parent,
          path,
          value: valueRef.current,
          original,
          readOnly: isDiff,
          wordWrap: window.localStorage.getItem(EDITOR_WORD_WRAP_KEY) === "true",
          theme,
          fontSize: BASE_EDITOR_FONT_SIZE * readUIFontScale(),
          onChange: (next) => onChangeRef.current(next),
        });
        // 编辑器为异步创建：创建完成后再对齐一次内容，覆盖创建期间的更新。
        editor.setValue(valueRef.current);
        editorRef.current = editor;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          const { t: translate, tError: translateError } = labelsRef.current;
          toast.error(translateError(error, translate("editorUnavailable")));
        }
      });
    return () => {
      disposed = true;
      editorRef.current?.destroy();
      editorRef.current = null;
    };
    // 路径、主题或读写模式变化时重建编辑器；wordWrap 与内容由下方 effect 动态应用。
  }, [original, path, theme, isDiff]);

  React.useEffect(() => {
    editorRef.current?.setValue(value);
  }, [value]);

  React.useEffect(() => {
    editorRef.current?.setWordWrap(wordWrap);
  }, [wordWrap]);

  const toggleWordWrap = React.useCallback(() => {
    setWordWrap((previous) => {
      const next = !previous;
      window.localStorage.setItem(EDITOR_WORD_WRAP_KEY, String(next));
      return next;
    });
  }, []);

  // 剪贴板动作包装：浏览器拒绝授权时统一提示。
  const runClipboard = React.useCallback(
    async (action: "copy" | "cut" | "paste") => {
      try {
        await editorRef.current?.[action]();
      } catch {
        toast.error(t("pasteHint"));
      }
    },
    [t],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={containerRef} className="h-full min-h-[240px] w-full" />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={isDiff} onClick={() => void runClipboard("cut")}>
          {t("cut")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void runClipboard("copy")}>{t("copy")}</ContextMenuItem>
        <ContextMenuItem disabled={isDiff} onClick={() => void runClipboard("paste")}>
          {t("paste")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => editorRef.current?.selectAll()}>{t("selectAll")}</ContextMenuItem>
        <ContextMenuItem onClick={() => editorRef.current?.find()}>{t("find")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={wordWrap} onCheckedChange={toggleWordWrap}>
          {t("wordWrap")}
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// 聊天区标签页内的文件编辑器：路径行 + 提示条 + 编辑器（Diff/删除态只读）。
// HTML/SVG 类文件支持在代码与预览视图间切换：预览会把相对引用的工作区资源（CSS/JS/图片/字体）
// 拉取并内联进沙箱 iframe，多文件页面无需上传即可完整渲染。
export function ProjectFileEditor({
  tab,
  busy,
  projectID,
  onPathChange,
  onContentChange,
  onSave,
  onDelete,
}: {
  tab: ProjectFileTab;
  busy: boolean;
  projectID: string;
  onPathChange: (path: string) => void;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("chat.workspace");
  const { resolvedTheme } = useTheme();
  const readOnly = Boolean(tab.diff) || tab.deleted;
  const previewable = isPreviewableFile(tab.path);
  const [view, setView] = React.useState<"code" | "preview">("code");
  const [previewDoc, setPreviewDoc] = React.useState("");
  const [previewMissing, setPreviewMissing] = React.useState<string[]>([]);
  // 资源缓存：避免每次内容变更都重新拉取工作区文件。
  const textCacheRef = React.useRef(new Map<string, string>());
  const dataUrlCacheRef = React.useRef(new Map<string, string>());
  const workspaceFilesRef = React.useRef<Map<string, ProjectWorkspaceFileDTO> | null>(null);

  // 切换文件时重置回代码视图，避免残留上一文件的预览状态。
  React.useEffect(() => {
    setView("code");
  }, [tab.key]);

  React.useEffect(() => {
    workspaceFilesRef.current = null;
    textCacheRef.current.clear();
    dataUrlCacheRef.current.clear();
  }, [projectID]);

  // 惰性加载工作区文件清单（按相对路径索引）。
  const ensureWorkspaceFiles = React.useCallback(async () => {
    if (workspaceFilesRef.current) {
      return workspaceFilesRef.current;
    }
    const token = await resolveAccessToken();
    if (!token) {
      return null;
    }
    const view = await getProjectWorkspace(token, projectID).catch(() => null);
    workspaceFilesRef.current = new Map((view?.Files ?? []).map((file) => [file.RelativePath, file]));
    return workspaceFilesRef.current;
  }, [projectID]);

  // 读取工作区文本资源（CSS/JS 等），未命中缓存返回 null。
  const fetchWorkspaceText = React.useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      const cached = textCacheRef.current.get(resolvedPath);
      if (cached !== undefined) {
        return cached || null;
      }
      const files = await ensureWorkspaceFiles();
      const file = files?.get(resolvedPath);
      if (!file) {
        textCacheRef.current.set(resolvedPath, "");
        return null;
      }
      const token = await resolveAccessToken();
      if (!token) {
        return null;
      }
      const text = await fetchProjectFileContent(token, projectID, file.PublicID).catch(() => null);
      textCacheRef.current.set(resolvedPath, text ?? "");
      return text;
    },
    [ensureWorkspaceFiles, projectID],
  );

  // 读取工作区资源并转为 data URL（图片/字体/SVG），用于 img src 与 CSS url()。
  const fetchWorkspaceDataUrl = React.useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      const cached = dataUrlCacheRef.current.get(resolvedPath);
      if (cached !== undefined) {
        return cached || null;
      }
      const files = await ensureWorkspaceFiles();
      const file = files?.get(resolvedPath);
      if (!file) {
        dataUrlCacheRef.current.set(resolvedPath, "");
        return null;
      }
      let dataUrl = "";
      if (resolvedPath.toLowerCase().endsWith(".svg")) {
        const text = await fetchWorkspaceText(resolvedPath);
        if (text) {
          dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(text)}`;
        }
      } else if (isBinaryAssetPath(resolvedPath)) {
        const token = await resolveAccessToken();
        if (token) {
          const blob = await fetchProjectFileBlob(token, projectID, file.PublicID).catch(() => null);
          if (blob) {
            dataUrl = await blobToDataUrl(blob).catch(() => "");
          }
        }
      }
      dataUrlCacheRef.current.set(resolvedPath, dataUrl);
      return dataUrl || null;
    },
    [ensureWorkspaceFiles, fetchWorkspaceText, projectID],
  );

  // CSS 文本处理：@import 递归内联（限两层），url() 引用转为 data URL。
  const inlineCss = React.useCallback(
    async (css: string, baseDir: string, depth: number): Promise<string> => {
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
            const text = await fetchWorkspaceText(resolved);
            if (text === null) {
              return statement;
            }
            return await inlineCss(text, directoryOf(resolved), depth + 1);
          },
        );
      }
      result = await replaceAsync(result, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (reference, _quote, ref) => {
        if (isExternalRef(ref) || ref.startsWith("data:") || isDynamicRef(ref)) {
          return reference;
        }
        const dataUrl = await fetchWorkspaceDataUrl(resolveWorkspacePath(baseDir, ref));
        return dataUrl ? `url("${dataUrl}")` : reference;
      });
      return result;
    },
    [fetchWorkspaceDataUrl, fetchWorkspaceText],
  );

  // 构建内联预览文档：link/script/img 与 style 块的相对引用全部解析为工作区资源，
  // 最后包进严格 CSP 沙箱文档。
  const buildPreviewDocument = React.useCallback(
    async (content: string, htmlPath: string): Promise<{ doc: string; missing: string[] }> => {
      const baseDir = directoryOf(htmlPath);
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
        const text = await fetchWorkspaceText(resolved);
        if (text === null) {
          missing.push(href);
          return tag;
        }
        return `<style>\n${await inlineCss(text, directoryOf(resolved), 1)}\n</style>`;
      });
      doc = await replaceAsync(doc, /<script\b([^>]*)>\s*<\/script>/gi, async (full, attrs) => {
        const src = extractAttr(full, "src");
        if (!src || isExternalRef(src) || isDynamicRef(src)) {
          return full;
        }
        const resolved = resolveWorkspacePath(baseDir, src);
        const text = await fetchWorkspaceText(resolved);
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
        const dataUrl = await fetchWorkspaceDataUrl(resolveWorkspacePath(baseDir, src));
        if (!dataUrl) {
          missing.push(src);
          return tag;
        }
        return tag.replace(src, dataUrl);
      });
      doc = await replaceAsync(
        doc,
        /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
        async (_full, open, css, close) => `${open}\n${await inlineCss(css, baseDir, 1)}\n${close}`,
      );
      const theme = captureHTMLVisualThemeSnapshot(resolvedTheme === "dark" ? "dark" : "light");
      return { doc: buildSandboxPreviewDocument(htmlPath, doc, theme), missing };
    },
    [fetchWorkspaceDataUrl, fetchWorkspaceText, inlineCss, resolvedTheme],
  );

  // 预览视图下内容变更时防抖重建内联文档（资源已缓存，重建为本地字符串操作）。
  React.useEffect(() => {
    if (view !== "preview") {
      return;
    }
    const source = tab.diff?.next ?? tab.content;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void buildPreviewDocument(source, tab.path)
        .then((result) => {
          if (cancelled) {
            return;
          }
          setPreviewDoc(result.doc);
          setPreviewMissing(result.missing);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          setPreviewDoc(buildSandboxPreviewDocument(tab.path, source, captureHTMLVisualThemeSnapshot(resolvedTheme === "dark" ? "dark" : "light")));
          setPreviewMissing([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [view, tab.key, tab.path, tab.content, tab.diff, buildPreviewDocument, resolvedTheme]);

  const missingList = previewMissing.slice(0, 4).join("、");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b p-2">
        <Input
          value={tab.path}
          onChange={(event) => onPathChange(event.target.value)}
          disabled={readOnly || Boolean(tab.fileID)}
          placeholder={t("pathPlaceholder")}
          className="h-7 text-xs"
        />
        {previewable ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title={view === "code" ? t("previewShow") : t("previewBack")}
            disabled={busy}
            onClick={() => setView(view === "code" ? "preview" : "code")}
          >
            {view === "code" ? <Eye /> : <Code2 />}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("save")}
          disabled={busy || readOnly || !tab.path.trim() || (Boolean(tab.fileID) && tab.content === tab.savedContent)}
          onClick={onSave}
        >
          <Save />
        </Button>
        <Button variant="ghost" size="icon-sm" title={tab.fileID ? t("deleteFile") : t("closeUnsaved")} disabled={busy} onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
      {tab.note ? (
        <div className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground">{tab.note}</div>
      ) : null}
      {previewable && view === "preview" ? (
        <>
          {previewMissing.length > 0 ? (
            <div
              className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground"
              title={previewMissing.join("\n")}
            >
              {t("unresolvedResources", { items: missingList })}
              {previewMissing.length > 4 ? t("unresolvedMore", { count: previewMissing.length }) : ""}
            </div>
          ) : null}
          {/* 沙箱 iframe：允许脚本运行但禁止同源访问，无法读写应用数据；工作区相对资源已内联。 */}
          <div className="min-h-0 flex-1 bg-white">
            <iframe
              title={t("previewTitle", { path: tab.path })}
              srcDoc={previewDoc || (tab.diff?.next ?? tab.content)}
              allow={SANDBOX_IFRAME_PERMISSIONS}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0"
            />
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1">
          <ProjectCodeEditor
            key={`${tab.key}:${tab.diff ? "diff" : "edit"}`}
            path={tab.path}
            value={tab.diff?.next ?? tab.content}
            original={tab.diff?.old}
            onChange={onContentChange}
          />
        </div>
      )}
    </div>
  );
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
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

function stringValue(record: Record<string, unknown> | null, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof record?.[key] === "string") {
      return record[key] as string;
    }
  }
  return "";
}

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
    const replaced = content.replace(part.newContent, () => part.oldContent as string);
    if (replaced !== content) {
      content = replaced;
    }
  }
  return content;
}

export type ProjectWorkspaceHandle = { refresh: () => void };

export const ChatProjectWorkspace = React.forwardRef<
  ProjectWorkspaceHandle,
  {
    projectID: string;
    messages: ChatAreaMessage[];
    width: number;
    onClose: () => void;
    activeTabPath: string;
    onOpenFile: (file: ProjectWorkspaceFileDTO) => void;
    onOpenChange: (change: ProjectChange) => void;
    onNewFile: (directory: string) => void;
    onFilesDeleted: (paths: string[]) => void;
    isDrawer?: boolean;
    generationActive?: boolean;
  }
>(function ChatProjectWorkspace(
  {
    projectID,
    messages,
    width,
    onClose,
    activeTabPath,
    onOpenFile,
    onOpenChange,
    onNewFile,
    onFilesDeleted,
    isDrawer = false,
    generationActive = false,
  },
  ref,
) {
  const t = useTranslations("chat.workspace");
  const tError = useLocalizedErrorMessage();
  const [files, setFiles] = React.useState<ProjectWorkspaceFileDTO[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [dropActive, setDropActive] = React.useState(false);
  const [dropTargetDirectory, setDropTargetDirectory] = React.useState("");
  const [collapsedDirectories, setCollapsedDirectories] = React.useState<Set<string>>(new Set());
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set());
  const [treeHeight, setTreeHeight] = React.useState(300);
  const archiveInputRef = React.useRef<HTMLInputElement>(null);
  const changeGroups = React.useMemo(() => projectChangeGroups(messages), [messages]);
  const changes = React.useMemo(() => changeGroups.flatMap((group) => group.changes), [changeGroups]);
  // 展开的变更分组（按 messageKey），默认全部折叠。
  const [expandedChangeGroups, setExpandedChangeGroups] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    const stored = Number(window.localStorage.getItem(PROJECT_TREE_HEIGHT_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      setTreeHeight(Math.min(720, Math.max(140, stored)));
    }
  }, []);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) {
        throw new Error(t("sessionExpired"));
      }
      const view = await getProjectWorkspace(token, projectID);
      setFiles(view.Files ?? []);
    } catch (error) {
      toast.error(tError(error, t("refreshFailed")));
    } finally {
      setBusy(false);
    }
  }, [projectID, t, tError]);

  React.useImperativeHandle(ref, () => ({ refresh: () => void refresh() }), [refresh]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // AI 产生新的项目文件变更后自动刷新文件列表（防抖，流式期间合并刷新）。
  const changesSignature = React.useMemo(() => changes.map((change) => change.key).join("\n"), [changes]);
  const lastChangesSignatureRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (lastChangesSignatureRef.current === null) {
      lastChangesSignatureRef.current = changesSignature;
      return;
    }
    if (lastChangesSignatureRef.current === changesSignature) {
      return;
    }
    lastChangesSignatureRef.current = changesSignature;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [changesSignature, refresh]);

  // 每轮生成结束（generationActive true→false）强制刷新一次：
  // 兜底覆盖写入/删除等未产生消息内变更事件的操作，列表不再需要手动刷新。
  const prevGenerationActiveRef = React.useRef(false);
  React.useEffect(() => {
    const wasActive = prevGenerationActiveRef.current;
    prevGenerationActiveRef.current = Boolean(generationActive);
    if (wasActive && !generationActive) {
      void refresh();
    }
  }, [generationActive, refresh]);

  // 下载整个项目为 ZIP 归档。
  const downloadArchive = React.useCallback(async () => {
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) {
        throw new Error(t("sessionExpired"));
      }
      const { blob, fileName } = await downloadProjectArchive(token, projectID);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(t("downloadStarted"));
    } catch (error) {
      toast.error(tError(error, t("downloadFailed")));
    } finally {
      setBusy(false);
    }
  }, [projectID, t, tError]);

  // 导入 ZIP 到项目工作区：走专用导入端点，不受聊天附件 MIME 白名单限制。
  const importArchive = React.useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".zip")) {
        toast.error(t("zipRequired"));
        return;
      }
      setBusy(true);
      try {
        const token = await resolveAccessToken();
        if (!token) {
          throw new Error(t("sessionExpired"));
        }
        await uploadProjectArchive(token, projectID, file);
        await refresh();
        toast.success(t("zipImported"));
      } catch (error) {
        toast.error(tError(error, t("zipImportFailed")));
      } finally {
        setBusy(false);
      }
    },
    [projectID, refresh, t, tError],
  );

  // 拖入的文件直接进入项目工作区而非对话附件：ZIP 解压导入，文本文件按原路径保存。
  // targetDirectory 非空时以该文件夹路径为前缀写入，实现拖到具体文件夹的定向添加。
  const importDroppedFiles = React.useCallback(
    async (dropped: FileList | File[], targetDirectory = "") => {
      const items = Array.from(dropped);
      if (items.length === 0) {
        return;
      }
      const prefix = targetDirectory.trim().replace(/^\/+|\/+$/g, "");
      setBusy(true);
      const token = await resolveAccessToken();
      try {
        if (!token) {
          throw new Error(t("sessionExpired"));
        }
        for (const file of items) {
          if (file.name.toLowerCase().endsWith(".zip")) {
            await uploadProjectArchive(token, projectID, file);
            continue;
          }
          const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() || file.name;
          const relative = prefix ? `${prefix}/${raw.replace(/^\/+/, "")}` : raw;
          if (!isTextLikeFile(file)) {
            toast.error(t("skippedBinary", { path: relative }));
            continue;
          }
          await saveProjectFile(token, projectID, relative, await file.text());
        }
        await refresh();
        toast.success(prefix ? t("filesAddedTo", { name: prefix }) : t("filesAdded"));
      } catch (error) {
        toast.error(tError(error, t("importFailed")));
      } finally {
        setBusy(false);
      }
    },
    [projectID, refresh, t, tError],
  );

  // 多选删除：文件按路径精确匹配，文件夹按前缀匹配其下全部文件。
  // 删除前先刷新列表：AI 改写文件会替换行（PublicID 变化），旧列表里的 ID 可能已失效；
  // 单个文件 404 视为"已被删除"，继续处理其余文件，避免整批中断。
  const removeSelected = React.useCallback(async () => {
    setBusy(true);
    let latestFiles: ProjectWorkspaceFileDTO[];
    try {
      const token = await resolveAccessToken();
      if (!token) {
        throw new Error(t("sessionExpired"));
      }
      const view = await getProjectWorkspace(token, projectID);
      latestFiles = view.Files ?? [];
      setFiles(latestFiles);
    } catch (error) {
      setBusy(false);
      toast.error(tError(error, t("refreshFailed")));
      return;
    }
    const targets = latestFiles.filter(
      (file) =>
        file.EntryType === "file" &&
        (selectedPaths.has(file.RelativePath) ||
          [...selectedPaths].some((prefix) => prefix !== "" && file.RelativePath.startsWith(`${prefix}/`))),
    );
    if (targets.length === 0) {
      setBusy(false);
      toast.error(t("noDeletableFiles"));
      return;
    }
    // biome-ignore lint/suspicious/noAlert: 批量删除为破坏性操作，沿用原生确认框以确保不可逆操作需二次确认
    if (!window.confirm(t("deleteConfirm", { count: targets.length }))) {
      setBusy(false);
      return;
    }
    try {
      const token = await resolveAccessToken();
      if (!token) {
        throw new Error(t("sessionExpired"));
      }
      let deletedCount = 0;
      let missingCount = 0;
      for (const file of targets) {
        try {
          await deleteProjectFile(token, projectID, file.PublicID);
          deletedCount += 1;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            missingCount += 1;
            continue;
          }
          throw error;
        }
      }
      setSelectedPaths(new Set());
      onFilesDeleted(targets.map((file) => file.RelativePath));
      await refresh();
      if (missingCount > 0) {
        toast.success(t("deletedSummaryPartial", { deleted: deletedCount, missing: missingCount }));
      } else {
        toast.success(t("deletedSummary", { count: deletedCount }));
      }
    } catch (error) {
      toast.error(tError(error, t("deleteFailed")));
    } finally {
      setBusy(false);
    }
  }, [onFilesDeleted, projectID, refresh, selectedPaths, t, tError]);

  const selectedFileCount = React.useMemo(
    () =>
      files.filter(
        (file) =>
          file.EntryType === "file" &&
          (selectedPaths.has(file.RelativePath) ||
            [...selectedPaths].some((prefix) => prefix !== "" && file.RelativePath.startsWith(`${prefix}/`))),
      ).length,
    [files, selectedPaths],
  );

  const workspaceTree = React.useMemo(() => buildWorkspaceTree(files, collapsedDirectories), [files, collapsedDirectories]);
  const allDirectories = React.useMemo(() => {
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = file.RelativePath.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i += 1) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    return dirs;
  }, [files]);

  const toggleDirectory = React.useCallback((directory: string) => {
    setCollapsedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(directory)) {
        next.delete(directory);
      } else {
        next.add(directory);
      }
      return next;
    });
  }, []);

  // 行点击：Ctrl/Cmd+点击切换多选；普通点击文件打开标签页、目录切换折叠。
  const toggleSelection = React.useCallback((path: string) => {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // 右键目标不在当前选区时先单选该目标，保证菜单操作对象符合直觉。
  const ensureSelectionForContextMenu = React.useCallback(
    (path: string) => {
      if (!selectedPaths.has(path)) {
        setSelectedPaths(new Set([path]));
      }
    },
    [selectedPaths],
  );

  // 文件夹行：进入/离开时更新拖放目标目录，松开时定向导入。
  const directoryDropHandlers = React.useCallback(
    (directory: string) => ({
      onDragEnter: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(true);
        setDropTargetDirectory(directory);
      },
      onDragOver: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropTargetDirectory(directory);
      },
      onDragLeave: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropTargetDirectory("");
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        setDropTargetDirectory("");
        if (busy) {
          return;
        }
        void importDroppedFiles(event.dataTransfer.files, directory);
      },
    }),
    [busy, importDroppedFiles],
  );

  // 文件树与每轮变更之间的分栏拖拽：调整文件树高度并持久化。
  const onTreeResizeStart = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startHeight = treeHeight;
      let nextHeight = startHeight;
      const move = (moveEvent: PointerEvent) => {
        nextHeight = Math.min(720, Math.max(140, startHeight - (moveEvent.clientY - startY)));
        setTreeHeight(nextHeight);
      };
      const stop = () => {
        window.localStorage.setItem(PROJECT_TREE_HEIGHT_KEY, String(nextHeight));
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    },
    [treeHeight],
  );

  return (
    <aside
      // 移动端为全宽抽屉覆盖层；桌面为内联侧栏（宽度由外层网格列与拖拽共同决定）。
      className={cn(
        "relative h-full min-h-0 shrink-0 flex-col border-l bg-background/95",
        isDrawer ? "fixed inset-y-0 right-0 z-50 flex w-full border-l-0 shadow-2xl" : "hidden md:flex",
      )}
      style={isDrawer ? undefined : { width }}
      // 拖放事件就地消费并阻断冒泡，避免落入外层对话附件区。
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.contains(event.relatedTarget as Node | null) === false) {
          setDropActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        if (busy) {
          return;
        }
        void importDroppedFiles(event.dataTransfer.files);
      }}
    >
      {dropActive ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary">
          <FilePlus2 className="size-5" />
          <span>{dropTargetDirectory ? t("dropToDirectory", { name: dropTargetDirectory }) : t("dropToWorkspace")}</span>
        </div>
      ) : null}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Folder className="size-4" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-[0.14em]">{t("explorer")}</span>
        <Button variant="ghost" size="icon-sm" title={t("newFile")} disabled={busy} onClick={() => onNewFile("")}>
          <FilePlus2 />
        </Button>
        <Button variant="ghost" size="icon-sm" title={t("importZip")} disabled={busy} onClick={() => archiveInputRef.current?.click()}>
          <FileArchive />
        </Button>
        <Button variant="ghost" size="icon-sm" title={t("downloadZip")} disabled={busy} onClick={() => void downloadArchive()}>
          <FolderArchive />
        </Button>
        <Button variant="ghost" size="icon-sm" title={t("refresh")} disabled={busy} onClick={() => void refresh()}>
          <RefreshCw className={busy ? "animate-spin" : ""} />
        </Button>
        <Button variant="ghost" size="icon-sm" title={t("closeIDE")} onClick={onClose}>
          <X />
        </Button>
      </header>
      <input
        ref={archiveInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void importArchive(file);
          }
        }}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: 容器点击仅用于点击空白处清除选择，非交互控件 */}
          <div
            className={cn("overflow-auto p-2", changeGroups.length > 0 ? "shrink-0 border-b" : "min-h-0 flex-1")}
            style={changeGroups.length > 0 ? { height: treeHeight } : undefined}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setSelectedPaths(new Set());
              }
            }}
          >
            {workspaceTree.map((node) =>
              node.kind === "directory" ? (
                <ContextMenu key={`dir-${node.path}`}>
                  <ContextMenuTrigger asChild>
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: 目录行点击用于展开/折叠，右键菜单提供键盘可达的新建入口 */}
                    <div
                      {...directoryDropHandlers(node.path)}
                      className={cn(
                        "flex h-7 cursor-pointer select-none items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:bg-muted/60",
                        selectedPaths.has(node.path) && "bg-primary/15 text-primary",
                        dropTargetDirectory === node.path && "bg-primary/15 text-primary",
                      )}
                      style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey) {
                          event.stopPropagation();
                          toggleSelection(node.path);
                          return;
                        }
                        toggleDirectory(node.path);
                      }}
                      onContextMenu={() => ensureSelectionForContextMenu(node.path)}
                    >
                      {collapsedDirectories.has(node.path) ? (
                        <ChevronRight className="size-3 shrink-0" />
                      ) : (
                        <ChevronDown className="size-3 shrink-0" />
                      )}
                      <Folder className="size-3.5 shrink-0" />
                      <span className="truncate">{node.label}</span>
                      <span className="ml-auto shrink-0 text-[10px] opacity-60">{node.count}</span>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => onNewFile(node.path)}>
                      {t("newFileIn", { name: node.label })}
                    </ContextMenuItem>
                    <ContextMenuItem disabled={busy || selectedFileCount === 0} onClick={() => void removeSelected()}>
                      {t("deleteSelected", { count: selectedFileCount })}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => toggleDirectory(node.path)}>
                      {collapsedDirectories.has(node.path) ? t("expandFolder") : t("collapseFolder")}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ) : (
                <ContextMenu key={`file-${node.file.PublicID}`}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey) {
                          event.stopPropagation();
                          toggleSelection(node.file.RelativePath);
                          return;
                        }
                        onOpenFile(node.file);
                      }}
                      onContextMenu={() => ensureSelectionForContextMenu(node.file.RelativePath)}
                      className={cn(
                        "flex h-7 w-full items-center gap-2 rounded px-1.5 text-left text-xs hover:bg-muted",
                        selectedPaths.has(node.file.RelativePath)
                          ? "bg-primary/15 text-primary"
                          : activeTabPath === node.file.RelativePath && "bg-muted",
                      )}
                      style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
                    >
                      <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{node.label}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => onOpenFile(node.file)}>{t("openFile")}</ContextMenuItem>
                    <ContextMenuItem disabled={busy || selectedFileCount === 0} onClick={() => void removeSelected()}>
                      {t("deleteSelected", { count: selectedFileCount })}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ),
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onNewFile("")}>{t("newFile")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setCollapsedDirectories(new Set(allDirectories))}>{t("collapseAll")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setCollapsedDirectories(new Set())}>{t("expandAll")}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={busy} onClick={() => void refresh()}>
            {t("refresh")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {changeGroups.length > 0 ? (
        <>
          <div
            role="separator"
            aria-label={t("resizeTree")}
            aria-valuenow={treeHeight}
            tabIndex={0}
            className="group relative z-10 h-1.5 shrink-0 cursor-row-resize touch-none"
            onPointerDown={onTreeResizeStart}
          >
            <div className="absolute inset-x-1 top-1/2 h-[2px] -translate-y-1/2 rounded bg-transparent group-hover:bg-primary/50" />
          </div>
          <section className="min-h-0 flex-1 overflow-auto p-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("changesTitle")}</span>
              <span className="text-[10px] text-muted-foreground">{t("changesRounds", { count: changeGroups.length })}</span>
            </div>
            {changeGroups.map((group) => {
              const expanded = expandedChangeGroups.has(group.messageKey);
              return (
                <div key={group.messageKey} className="mb-1">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedChangeGroups((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.messageKey)) {
                          next.delete(group.messageKey);
                        } else {
                          next.add(group.messageKey);
                        }
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
                    title={group.title}
                  >
                    {expanded ? (
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{group.title}</span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {group.changes.length}
                    </span>
                  </button>
                  {expanded
                    ? group.changes.map((change) => (
                        <button
                          key={change.key}
                          type="button"
                          onClick={() => onOpenChange(change)}
                          className="ml-3 mb-0.5 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left hover:bg-muted/60"
                        >
                          {change.name === "project_delete_file" ? (
                            <Trash2 className="size-3.5 text-destructive" />
                          ) : change.name === "project_create_archive" ? (
                            <FolderArchive className="size-3.5 text-muted-foreground" />
                          ) : (
                            <FileDiff className="size-3.5 text-muted-foreground" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-medium">
                              {change.name === "project_create_archive" ? t("archiveEntry") : change.path}
                            </span>
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {change.name === "project_create_archive"
                                ? t("archiveClickDownload")
                                : change.parts && change.parts.length > 1
                                  ? t("mergedDiff", { count: change.parts.length })
                                  : change.name.replace("project_", "")}
                            </span>
                          </span>
                        </button>
                      ))
                    : null}
                </div>
              );
            })}
          </section>
        </>
      ) : null}
    </aside>
  );
});
