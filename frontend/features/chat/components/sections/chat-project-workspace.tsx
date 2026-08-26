"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
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
import type * as Monaco from "monaco-editor";
import { useTheme } from "@/shared/components/theme-provider";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import type { ChatAreaMessage } from "@/features/chat/types/messages";
import {
  deleteProjectFile,
  downloadProjectArchive,
  fetchProjectFileBlob,
  fetchProjectFileContent,
  getProjectWorkspace,
  saveProjectFile,
  uploadProjectArchive,
  type ProjectWorkspaceFileDTO,
} from "@/shared/api/conversation";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { cn } from "@/lib/utils";

type MonacoModule = typeof Monaco;

const PROJECT_TREE_HEIGHT_KEY = "deeix-chat:project-tree-height";
const EDITOR_WORD_WRAP_KEY = "deeix-chat:editor-word-wrap";

// 判断拖入文件是否可按文本保存到项目工作区（二进制文件不适用文本写入端点）。
function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith("text/") || file.type === "application/json" || file.type === "application/xml" ||
    file.type === "application/yaml" || file.type === "application/x-yaml" || file.type === "application/toml") {
    return true;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["css", "go", "html", "java", "js", "json", "jsx", "md", "markdown", "mjs", "py", "rs", "scss", "sh",
    "sql", "svg", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "toml", "cjs"].includes(extension);
}

// 工作区树节点：目录与文件统一渲染，支持折叠与多选。
type WorkspaceTreeNode =
  | { kind: "directory"; path: string; label: string; depth: number; count: number }
  | { kind: "file"; path: string; label: string; depth: number; file: ProjectWorkspaceFileDTO };

interface DirectoryNode {
  dirs: Map<string, DirectoryNode>;
  files: Map<string, ProjectWorkspaceFileDTO>;
  count: number;
}

// 递归构建文件树并按 DFS 展平：目录在文件之前、同级按名称排序，保证父子级紧邻排列。
function buildWorkspaceTree(files: ProjectWorkspaceFileDTO[], collapsed: Set<string>): WorkspaceTreeNode[] {
  const root: DirectoryNode = { dirs: new Map(), files: new Map(), count: 0 };
  for (const file of files) {
    if (file.EntryType !== "file") continue;
    const parts = file.RelativePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    current.count += 1;
    for (let i = 0; i < parts.length - 1; i++) {
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
      rows.push({ kind: "directory", path: dirPath, label: dirPath.split("/").at(-1) ?? dirPath, depth, count: dirNode.count });
      if (!collapsed.has(dirPath)) walk(dirNode, depth + 1);
    }
    for (const file of fileRows) {
      rows.push({ kind: "file", path: file.RelativePath, label: file.FileName, depth, file });
    }
  };
  walk(root, 0);
  return rows;
}

let monacoPromise: Promise<MonacoModule> | null = null;

function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) {
    const browserGlobal = globalThis as typeof globalThis & {
      MonacoEnvironment?: { getWorker?: (workerID: string, label: string) => Worker };
    };
    // 按标签分发语言服务 worker：TS/JSON/CSS/HTML 提供补全与校验，其余语言词法在主线程无需专属 worker。
    // 每个 new URL 字面量都会被打包器静态识别并产出独立 worker chunk。
    browserGlobal.MonacoEnvironment = {
      getWorker: (_workerID: string, label: string) => {
        if (label === "typescript" || label === "javascript") {
          return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
        }
        if (label === "json") {
          return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
        }
        if (label === "css" || label === "scss" || label === "less") {
          return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
        }
        if (label === "html") {
          return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
        }
        return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
      },
    };
    monacoPromise = Promise.all([
      // 官方全量入口：编辑器全部 contribs + 全部基础语言词法（高亮）+ TS/JSON/CSS/HTML 四套语言服务（补全）。
      import("monaco-editor/esm/vs/editor/editor.main.js"),
      // 类型完整的 API 命名空间；与 main.js 共享同一内部单例（initialize.js）。
      import("monaco-editor/esm/vs/editor/editor.api.js"),
      // TS 语言服务配置入口：0.55 起 monaco.languages.typescript 类型被标记 deprecated，需从贡献模块直接导入。
      import("monaco-editor/esm/vs/language/typescript/monaco.contribution.js"),
    ]).then(([, monaco, ts]) => {
      // 项目文件多为无依赖的独立片段：放开扩展名限制并启用 JSX，让 tsx/jsx 同样获得语义补全。
      ts.typescriptDefaults.setCompilerOptions({ allowNonTsExtensions: true, jsx: ts.JsxEmit.React });
      ts.javascriptDefaults.setCompilerOptions({ allowNonTsExtensions: true, jsx: ts.JsxEmit.React });
      return monaco;
    });
  }
  return monacoPromise;
}

function languageForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    css: "css", go: "go", html: "html", java: "java", js: "javascript", json: "json",
    jsx: "javascript", md: "markdown", py: "python", rs: "rust", scss: "scss", sh: "shell",
    sql: "sql", ts: "typescript", tsx: "typescript", vue: "html", xml: "xml", yaml: "yaml", yml: "yaml",
  } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

type DiffLineKind = "context" | "add" | "remove";

// 基于行级 LCS 的轻量 Diff：合并旧新内容为单编辑器视图，保证只有一列行号。
function computeLineDiff(oldText: string, newText: string): { lines: string[]; kinds: DiffLineKind[] } {
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
  const newLines = newText.length === 0 ? [] : newText.split("\n");
  if (oldLines.length * newLines.length > 4_000_000) {
    return {
      lines: [...oldLines, ...newLines],
      kinds: [...oldLines.map(() => "remove" as const), ...newLines.map(() => "add" as const)],
    };
  }
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [];
  const kinds: DiffLineKind[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      lines.push(oldLines[i]);
      kinds.push("context");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(oldLines[i]);
      kinds.push("remove");
      i++;
    } else {
      lines.push(newLines[j]);
      kinds.push("add");
      j++;
    }
  }
  while (i < rows) {
    lines.push(oldLines[i]);
    kinds.push("remove");
    i++;
  }
  while (j < cols) {
    lines.push(newLines[j]);
    kinds.push("add");
    j++;
  }
  return { lines, kinds };
}

// 注入 Diff 装饰样式（幂等）。
function ensureDiffStyles() {
  if (typeof document === "undefined" || document.getElementById("deeix-diff-styles")) return;
  const style = document.createElement("style");
  style.id = "deeix-diff-styles";
  style.textContent = [
    ".deeix-diff-add { background: rgba(46, 160, 67, 0.16); }",
    ".deeix-diff-remove { background: rgba(248, 113, 113, 0.14); text-decoration: line-through; text-decoration-color: rgba(248, 113, 113, 0.6); }",
  ].join("\n");
  document.head.appendChild(style);
}

function CodeEditor({ path, value, original, onChange }: { path: string; value: string; original?: string; onChange: (value: string) => void }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = React.useRef<MonacoModule | null>(null);
  const decorationsRef = React.useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const onChangeRef = React.useRef(onChange);
  const { resolvedTheme } = useTheme();
  const tWorkspace = useTranslations("chat.workspace");
  const isDiff = original !== undefined;
  // 自动换行为全局偏好：所有编辑器标签共享，持久化到 localStorage。
  const [wordWrap, setWordWrap] = React.useState(() => typeof window !== "undefined" && window.localStorage.getItem(EDITOR_WORD_WRAP_KEY) === "true");

  const toggleWordWrap = React.useCallback(() => {
    setWordWrap((previous) => {
      const next = !previous;
      window.localStorage.setItem(EDITOR_WORD_WRAP_KEY, String(next));
      editorRef.current?.updateOptions({ wordWrap: next ? "on" : "off" });
      return next;
    });
  }, []);

  // 编辑器右键动作：聚焦后触发 Monaco 内置动作，保证与快捷键行为一致。
  const triggerEditorAction = React.useCallback((action: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.trigger("keyboard", action, {});
  }, []);

  // 粘贴：优先读取剪贴板并替换当前选区；浏览器拒绝授权时提示改用 Ctrl+V。
  const pasteFromClipboard = React.useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    try {
      const text = await navigator.clipboard.readText();
      const selection = editor.getSelection();
      if (selection) editor.executeEdits("deeix-paste", [{ range: selection, text, forceMoveMarkers: true }]);
    } catch {
      toast.error(tWorkspace("pasteHint"));
    }
  }, [tWorkspace]);

  React.useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const monaco = monacoRef.current;
    if (!monaco) return;
    if (original !== undefined) {
      const model = editor.getModel();
      if (!model) return;
      const merged = computeLineDiff(original, value);
      model.setValue(merged.lines.join("\n"));
      decorationsRef.current?.set(merged.kinds.flatMap((kind, index) => kind === "context" ? [] : [{
        range: new monaco.Range(index + 1, 1, index + 1, 1),
        options: { isWholeLine: true, className: kind === "add" ? "deeix-diff-add" : "deeix-diff-remove" },
      }]));
      return;
    }
    if (editor.getValue() !== value) editor.setValue(value);
  }, [original, value]);
  React.useEffect(() => {
    let disposed = false;
    let subscription: Monaco.IDisposable | undefined;
    let model: Monaco.editor.ITextModel | null = null;
    void loadMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      ensureDiffStyles();
      monacoRef.current = monaco;
      const language = languageForPath(path);
      const options: Monaco.editor.IStandaloneEditorConstructionOptions = {
        automaticLayout: true, fontSize: 12, lineHeight: 20, minimap: { enabled: false },
        padding: { top: 12 }, scrollBeyondLastLine: false, theme: resolvedTheme === "dark" ? "vs-dark" : "vs",
        // 禁用 Monaco 内置英文右键菜单，改用外层本地化菜单。
        contextmenu: false,
        wordWrap: wordWrap ? "on" : "off",
      };
      const isDiffView = original !== undefined;
      const merged = isDiffView ? computeLineDiff(original, value) : null;
      model = monaco.editor.createModel(merged ? merged.lines.join("\n") : value, language);
      const editor = monaco.editor.create(containerRef.current, { ...options, model, readOnly: isDiffView });
      if (merged) {
        decorationsRef.current = editor.createDecorationsCollection(merged.kinds.flatMap((kind, index) => kind === "context" ? [] : [{
          range: new monaco.Range(index + 1, 1, index + 1, 1),
          options: { isWholeLine: true, className: kind === "add" ? "deeix-diff-add" : "deeix-diff-remove" },
        }]));
      } else {
        subscription = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
      }
      editorRef.current = editor;
    });
    return () => {
      disposed = true;
      subscription?.dispose();
      editorRef.current?.dispose();
      model?.dispose();
      decorationsRef.current = null;
      editorRef.current = null;
    };
    // wordWrap 通过 toggleWordWrap 的 updateOptions 动态应用，不参与重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, path, resolvedTheme]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={containerRef} className="h-full min-h-[240px] w-full" />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={isDiff} onClick={() => triggerEditorAction("editor.action.clipboardCutAction")}>{tWorkspace("cut")}</ContextMenuItem>
        <ContextMenuItem onClick={() => triggerEditorAction("editor.action.clipboardCopyAction")}>{tWorkspace("copy")}</ContextMenuItem>
        <ContextMenuItem disabled={isDiff} onClick={() => void pasteFromClipboard()}>{tWorkspace("paste")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => triggerEditorAction("editor.action.selectAll")}>{tWorkspace("selectAll")}</ContextMenuItem>
        <ContextMenuItem onClick={() => triggerEditorAction("actions.find")}>{tWorkspace("find")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={wordWrap} onCheckedChange={toggleWordWrap}>{tWorkspace("wordWrap")}</ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
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
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/");
}

const BINARY_ASSET_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "woff", "woff2", "ttf", "otf", "eot"]);

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
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? "").trim() || null;
}

function removeAttr(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"), "");
}

// 异步正则替换：并发执行替换函数但保持匹配顺序，避免结果乱序。
async function replaceAsync(input: string, pattern: RegExp, replacer: (match: string, ...groups: string[]) => Promise<string>): Promise<string> {
  const matches = [...input.matchAll(pattern)];
  if (matches.length === 0) return input;
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

// 聊天区标签页内的文件编辑器：路径行 + 提示条 + Monaco 编辑器（Diff/删除态只读）。
// HTML/SVG 类文件支持在代码与预览视图间切换：预览会把相对引用的工作区资源（CSS/JS/图片/字体）
// 拉取并内联进沙箱 iframe，多文件页面无需上传即可完整渲染。
export function ProjectFileEditor({ tab, busy, projectID, onPathChange, onContentChange, onSave, onDelete }: {
  tab: ProjectFileTab;
  busy: boolean;
  projectID: string;
  onPathChange: (path: string) => void;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
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
  React.useEffect(() => { setView("code"); }, [tab.key]);

  React.useEffect(() => {
    workspaceFilesRef.current = null;
    textCacheRef.current.clear();
    dataUrlCacheRef.current.clear();
  }, [projectID]);

  // 惰性加载工作区文件清单（按相对路径索引）。
  const ensureWorkspaceFiles = React.useCallback(async () => {
    if (workspaceFilesRef.current) return workspaceFilesRef.current;
    const token = await resolveAccessToken();
    if (!token) return null;
    const view = await getProjectWorkspace(token, projectID).catch(() => null);
    workspaceFilesRef.current = new Map((view?.Files ?? []).map((file) => [file.RelativePath, file]));
    return workspaceFilesRef.current;
  }, [projectID]);

  // 读取工作区文本资源（CSS/JS 等），未命中缓存返回 null。
  const fetchWorkspaceText = React.useCallback(async (resolvedPath: string): Promise<string | null> => {
    const cached = textCacheRef.current.get(resolvedPath);
    if (cached !== undefined) return cached || null;
    const files = await ensureWorkspaceFiles();
    const file = files?.get(resolvedPath);
    if (!file) {
      textCacheRef.current.set(resolvedPath, "");
      return null;
    }
    const token = await resolveAccessToken();
    if (!token) return null;
    const text = await fetchProjectFileContent(token, projectID, file.PublicID).catch(() => null);
    textCacheRef.current.set(resolvedPath, text ?? "");
    return text;
  }, [ensureWorkspaceFiles, projectID]);

  // 读取工作区资源并转为 data URL（图片/字体/SVG），用于 img src 与 CSS url()。
  const fetchWorkspaceDataUrl = React.useCallback(async (resolvedPath: string): Promise<string | null> => {
    const cached = dataUrlCacheRef.current.get(resolvedPath);
    if (cached !== undefined) return cached || null;
    const files = await ensureWorkspaceFiles();
    const file = files?.get(resolvedPath);
    if (!file) {
      dataUrlCacheRef.current.set(resolvedPath, "");
      return null;
    }
    let dataUrl = "";
    if (resolvedPath.toLowerCase().endsWith(".svg")) {
      const text = await fetchWorkspaceText(resolvedPath);
      if (text) dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(text)}`;
    } else if (isBinaryAssetPath(resolvedPath)) {
      const token = await resolveAccessToken();
      if (token) {
        const blob = await fetchProjectFileBlob(token, projectID, file.PublicID).catch(() => null);
        if (blob) dataUrl = await blobToDataUrl(blob).catch(() => "");
      }
    }
    dataUrlCacheRef.current.set(resolvedPath, dataUrl);
    return dataUrl || null;
  }, [ensureWorkspaceFiles, fetchWorkspaceText, projectID]);

  // CSS 文本处理：@import 递归内联（限两层），url() 引用转为 data URL。
  const inlineCss = React.useCallback(async (css: string, baseDir: string, depth: number): Promise<string> => {
    let result = css;
    if (depth < 3) {
      result = await replaceAsync(result, /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi, async (statement, ref) => {
        if (isExternalRef(ref) || !ref.toLowerCase().endsWith(".css")) return statement;
        const resolved = resolveWorkspacePath(baseDir, ref);
        const text = await fetchWorkspaceText(resolved);
        if (text === null) return statement;
        return await inlineCss(text, directoryOf(resolved), depth + 1);
      });
    }
    result = await replaceAsync(result, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (reference, _quote, ref) => {
      if (isExternalRef(ref) || ref.startsWith("data:") || isDynamicRef(ref)) return reference;
      const dataUrl = await fetchWorkspaceDataUrl(resolveWorkspacePath(baseDir, ref));
      return dataUrl ? `url("${dataUrl}")` : reference;
    });
    return result;
  }, [fetchWorkspaceDataUrl, fetchWorkspaceText]);

  // 构建内联预览文档：link/script/img 与 style 块的相对引用全部解析为工作区资源。
  const buildPreviewDocument = React.useCallback(async (content: string, htmlPath: string): Promise<{ doc: string; missing: string[] }> => {
    const baseDir = directoryOf(htmlPath);
    const missing: string[] = [];
    let doc = content;
    doc = await replaceAsync(doc, /<link\b[^>]*>/gi, async (tag) => {
      const rel = extractAttr(tag, "rel") ?? "";
      if (!/stylesheet/i.test(rel)) return tag;
      const href = extractAttr(tag, "href");
      if (!href || isExternalRef(href) || isDynamicRef(href)) return tag;
      const resolved = resolveWorkspacePath(baseDir, href);
      const text = await fetchWorkspaceText(resolved);
      if (text === null) { missing.push(href); return tag; }
      return `<style>\n${await inlineCss(text, directoryOf(resolved), 1)}\n</style>`;
    });
    doc = await replaceAsync(doc, /<script\b([^>]*)>\s*<\/script>/gi, async (full, attrs) => {
      const src = extractAttr(full, "src");
      if (!src || isExternalRef(src) || isDynamicRef(src)) return full;
      const resolved = resolveWorkspacePath(baseDir, src);
      const text = await fetchWorkspaceText(resolved);
      if (text === null) { missing.push(src); return full; }
      return `<script${removeAttr(` ${attrs}`, "src").trimEnd()}>\n${text}\n</script>`;
    });
    doc = await replaceAsync(doc, /<img\b[^>]*>/gi, async (tag) => {
      const src = extractAttr(tag, "src");
      if (!src || isExternalRef(src) || isDynamicRef(src)) return tag;
      const dataUrl = await fetchWorkspaceDataUrl(resolveWorkspacePath(baseDir, src));
      if (!dataUrl) { missing.push(src); return tag; }
      return tag.replace(src, dataUrl);
    });
    doc = await replaceAsync(doc, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (_full, open, css, close) => `${open}\n${await inlineCss(css, baseDir, 1)}\n${close}`);
    return { doc, missing };
  }, [fetchWorkspaceDataUrl, fetchWorkspaceText, inlineCss]);

  // 预览视图下内容变更时防抖重建内联文档（资源已缓存，重建为本地字符串操作）。
  React.useEffect(() => {
    if (view !== "preview") return;
    const source = tab.diff?.next ?? tab.content;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void buildPreviewDocument(source, tab.path).then((result) => {
        if (cancelled) return;
        setPreviewDoc(result.doc);
        setPreviewMissing(result.missing);
      }).catch(() => {
        if (cancelled) return;
        setPreviewDoc(source);
        setPreviewMissing([]);
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [view, tab.key, tab.path, tab.content, tab.diff, buildPreviewDocument]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b p-2">
        <Input
          value={tab.path}
          onChange={(event) => onPathChange(event.target.value)}
          disabled={readOnly || Boolean(tab.fileID)}
          placeholder="src/file.ts"
          className="h-7 text-xs"
        />
        {previewable ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title={view === "code" ? "预览渲染效果" : "返回代码编辑"}
            disabled={busy}
            onClick={() => setView(view === "code" ? "preview" : "code")}
          >
            {view === "code" ? <Eye /> : <Code2 />}
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" title="保存" disabled={busy || readOnly || !tab.path.trim() || (Boolean(tab.fileID) && tab.content === tab.savedContent)} onClick={onSave}><Save /></Button>
        <Button variant="ghost" size="icon-sm" title={tab.fileID ? "删除文件" : "关闭未保存文件"} disabled={busy} onClick={onDelete}><Trash2 /></Button>
      </div>
      {tab.note ? <div className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground">{tab.note}</div> : null}
      {previewable && view === "preview" ? (
        <>
          {previewMissing.length > 0 ? (
            <div className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground" title={previewMissing.join("\n")}>
              未解析资源（工作区中不存在）：{previewMissing.slice(0, 4).join("、")}{previewMissing.length > 4 ? ` 等 ${previewMissing.length} 项` : ""}
            </div>
          ) : null}
          {/* 沙箱 iframe：允许脚本运行但禁止同源访问，无法读写应用数据；工作区相对资源已内联。 */}
          <div className="min-h-0 flex-1 bg-white">
            <iframe
              title={`预览 ${tab.path}`}
              srcDoc={previewDoc || (tab.diff?.next ?? tab.content)}
              sandbox="allow-scripts allow-popups"
              className="h-full w-full border-0"
            />
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1">
          <CodeEditor key={`${tab.key}:${tab.diff ? "diff" : "edit"}`} path={tab.path} value={tab.diff?.next ?? tab.content} original={tab.diff?.old} onChange={onContentChange} />
        </div>
      )}
    </div>
  );
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try { return parseRecord(JSON.parse(value)); } catch { return null; }
}

function stringValue(record: Record<string, unknown> | null, ...keys: string[]): string {
  for (const key of keys) if (typeof record?.[key] === "string") return record[key] as string;
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
    const events = message.processTrace?.events ?? [];
    const sources = events.length > 0 ? events : message.processTrace?.tools ? [{ ...message.processTrace.tools, eventID: `${message.key}-tools` }] : [];
    const changes: ProjectChange[] = [];
    for (const event of sources) {
      const payload = parseRecord(event.payloadJson);
      const calls = Array.isArray(payload?.tool_calls) ? payload.tool_calls : [];
      calls.forEach((raw, index) => {
        const call = parseRecord(raw);
        const name = stringValue(call, "name");
        if (name === "project_create_archive") {
          changes.push({
            key: `${message.key}-${"eventID" in event ? event.eventID : index}-${index}`,
            messageKey: message.key,
            round: event.roundID || `Round ${index + 1}`,
            name,
            path: "",
          });
          return;
        }
        if (!["project_write_file", "project_patch_file", "project_delete_file"].includes(name)) return;
        const input = parseRecord(stringValue(call, "input_detail", "input_preview", "input"));
        const path = stringValue(input, "path", "file");
        if (!path) return;
        // patch 的多片段模式：每个片段生成独立的变更条目，便于逐段查看 Diff。
        if (name === "project_patch_file" && Array.isArray(input?.patches) && input.patches.length > 0) {
          input.patches.forEach((raw, patchIndex) => {
            const patch = parseRecord(raw);
            if (!patch) return;
            changes.push({
              key: `${message.key}-${"eventID" in event ? event.eventID : index}-${index}-${patchIndex}`,
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
          key: `${message.key}-${"eventID" in event ? event.eventID : index}-${index}`,
          messageKey: message.key,
          round: event.roundID || `Round ${index + 1}`,
          name,
          path,
          oldContent: name === "project_patch_file" ? stringValue(input, "old") : name === "project_write_file" ? "" : undefined,
          newContent: name === "project_patch_file" ? stringValue(input, "new") : name === "project_write_file" ? stringValue(input, "content") : undefined,
        });
      });
    }
    if (changes.length > 0) {
      const parent = message.parentPublicID ? byPublicID.get(message.parentPublicID) : undefined;
      const title = plainText(parent && parent.role === "user" ? parent.content : message.content) || `对话 ${groups.length + 1}`;
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
  if (changes.length < 2) return changes;
  const buckets = new Map<string, ProjectChange[]>();
  let hasDuplicate = false;
  for (const change of changes) {
    if (change.name === "project_create_archive") continue;
    const bucket = buckets.get(change.path);
    if (bucket) { bucket.push(change); hasDuplicate = true; }
    else buckets.set(change.path, [change]);
  }
  if (!hasDuplicate) return changes;
  const merged: ProjectChange[] = [];
  const emitted = new Set<string>();
  for (const change of changes) {
    if (change.name === "project_create_archive") { merged.push(change); continue; }
    if (emitted.has(change.path)) continue;
    emitted.add(change.path);
    const parts = buckets.get(change.path) ?? [change];
    if (parts.length === 1) { merged.push(change); continue; }
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
  if (!path) return [];
  return projectChangeGroups(messages)
    .flatMap((group) => group.changes)
    .filter((change) => change.path === path && change.name !== "project_create_archive")
    .flatMap((change) => change.parts ?? [change]);
}

// 逆序还原补丁，重建文件在某批变更之前的初始内容；出现全量 write 时其之前的历史已被覆盖，以空内容为基准。
export function reconstructProjectFileInitial(final: string, parts: ProjectChange[]): string {
  let lastWriteIndex = -1;
  parts.forEach((part, index) => { if (part.name === "project_write_file") lastWriteIndex = index; });
  if (lastWriteIndex >= 0) return "";
  let content = final;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.name !== "project_patch_file") continue;
    // 空 new（片段被移除）无法定位还原位置，跳过该片段。
    if (!part.newContent || part.oldContent === undefined || part.oldContent === null) continue;
    // 用函数形式替换，避免 oldContent 中的 $& 等模式被当作替换模式解释。
    const replaced = content.replace(part.newContent, () => part.oldContent as string);
    if (replaced !== content) content = replaced;
  }
  return content;
}

export type ProjectWorkspaceHandle = { refresh: () => void };

export const ChatProjectWorkspace = React.forwardRef<ProjectWorkspaceHandle, {
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
}>(function ChatProjectWorkspace({ projectID, messages, width, onClose, activeTabPath, onOpenFile, onOpenChange, onNewFile, onFilesDeleted, isDrawer = false }, ref) {
  const tWorkspace = useTranslations("chat.workspace");
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
    if (Number.isFinite(stored) && stored > 0) setTreeHeight(Math.min(720, Math.max(140, stored)));
  }, []);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      const view = await getProjectWorkspace(token, projectID);
      setFiles(view.Files ?? []);
    } catch (error) { toast.error(error instanceof Error ? error.message : "无法刷新项目文件"); }
    finally { setBusy(false); }
  }, [projectID]);

  React.useImperativeHandle(ref, () => ({ refresh: () => void refresh() }), [refresh]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  // AI 产生新的项目文件变更后自动刷新文件列表（防抖，流式期间合并刷新）。
  const changesSignature = React.useMemo(() => changes.map((change) => change.key).join("\n"), [changes]);
  const lastChangesSignatureRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (lastChangesSignatureRef.current === null) {
      lastChangesSignatureRef.current = changesSignature;
      return;
    }
    if (lastChangesSignatureRef.current === changesSignature) return;
    lastChangesSignatureRef.current = changesSignature;
    const timer = window.setTimeout(() => { void refresh(); }, 500);
    return () => window.clearTimeout(timer);
  }, [changesSignature, refresh]);

  // 下载整个项目为 ZIP 归档。
  async function downloadArchive() {
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      const { blob, fileName } = await downloadProjectArchive(token, projectID);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success("项目归档已开始下载");
    } catch (error) { toast.error(error instanceof Error ? error.message : "下载失败"); }
    finally { setBusy(false); }
  }

  // 导入 ZIP 到项目工作区：走专用导入端点，不受聊天附件 MIME 白名单限制。
  async function importArchive(file: File) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("请选择 ZIP 压缩包");
      return;
    }
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      await uploadProjectArchive(token, projectID, file);
      await refresh();
      toast.success("ZIP 已导入项目文件");
    } catch (error) { toast.error(error instanceof Error ? error.message : "ZIP 导入失败"); }
    finally { setBusy(false); }
  }

  // 拖入的文件直接进入项目工作区而非对话附件：ZIP 解压导入，文本文件按原路径保存。
  // targetDirectory 非空时以该文件夹路径为前缀写入，实现拖到具体文件夹的定向添加。
  async function importDroppedFiles(dropped: FileList | File[], targetDirectory = "") {
    const items = Array.from(dropped);
    if (items.length === 0) return;
    const prefix = targetDirectory.trim().replace(/^\/+|\/+$/g, "");
    setBusy(true);
    const token = await resolveAccessToken();
    try {
      if (!token) throw new Error("登录状态已失效");
      for (const file of items) {
        if (file.name.toLowerCase().endsWith(".zip")) {
          await uploadProjectArchive(token, projectID, file);
          continue;
        }
        const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() || file.name;
        const relative = prefix ? `${prefix}/${raw.replace(/^\/+/, "")}` : raw;
        if (!isTextLikeFile(file)) {
          toast.error(`已跳过 ${relative}：仅支持 ZIP 或文本类文件`);
          continue;
        }
        await saveProjectFile(token, projectID, relative, await file.text());
      }
      await refresh();
      toast.success(prefix ? `文件已添加到 ${prefix}/` : "文件已添加到项目工作区");
    } catch (error) { toast.error(error instanceof Error ? error.message : "文件导入失败"); }
    finally { setBusy(false); }
  }

  // 多选删除：文件按路径精确匹配，文件夹按前缀匹配其下全部文件。
  async function removeSelected() {
    const targets = files.filter((file) => file.EntryType === "file" && (
      selectedPaths.has(file.RelativePath) ||
      [...selectedPaths].some((prefix) => prefix !== "" && file.RelativePath.startsWith(`${prefix}/`))
    ));
    if (targets.length === 0) {
      toast.error("没有可删除的文件");
      return;
    }
    if (!window.confirm(`确定删除选中的 ${targets.length} 个文件吗？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      const token = await resolveAccessToken();
      if (!token) throw new Error("登录状态已失效");
      for (const file of targets) {
        await deleteProjectFile(token, projectID, file.PublicID);
      }
      setSelectedPaths(new Set());
      onFilesDeleted(targets.map((file) => file.RelativePath));
      await refresh();
      toast.success(`已删除 ${targets.length} 个文件`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "删除失败"); }
    finally { setBusy(false); }
  }

  const selectedFileCount = React.useMemo(() => files.filter((file) => file.EntryType === "file" && (
    selectedPaths.has(file.RelativePath) ||
    [...selectedPaths].some((prefix) => prefix !== "" && file.RelativePath.startsWith(`${prefix}/`))
  )).length, [files, selectedPaths]);

  const workspaceTree = React.useMemo(() => buildWorkspaceTree(files, collapsedDirectories), [files, collapsedDirectories]);
  const allDirectories = React.useMemo(() => {
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = file.RelativePath.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }, [files]);

  const toggleDirectory = React.useCallback((directory: string) => {
    setCollapsedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
  }, []);

  // 行点击：Ctrl/Cmd+点击切换多选；普通点击文件打开标签页、目录切换折叠。
  const toggleSelection = React.useCallback((path: string) => {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // 右键目标不在当前选区时先单选该目标，保证菜单操作对象符合直觉。
  const ensureSelectionForContextMenu = React.useCallback((path: string) => {
    if (!selectedPaths.has(path)) setSelectedPaths(new Set([path]));
  }, [selectedPaths]);

  // 文件夹行：进入/离开时更新拖放目标目录，松开时定向导入。
  const directoryDropHandlers = React.useCallback((directory: string) => ({
    onDragEnter: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); setDropActive(true); setDropTargetDirectory(directory); },
    onDragOver: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); setDropTargetDirectory(directory); },
    onDragLeave: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); setDropTargetDirectory(""); },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropActive(false);
      setDropTargetDirectory("");
      if (busy) return;
      void importDroppedFiles(event.dataTransfer.files, directory);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [busy, projectID]);

  // 文件树与每轮变更之间的分栏拖拽：调整文件树高度并持久化。
  const onTreeResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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
  }, [treeHeight]);

  return (
    <aside
      // 移动端为全宽抽屉覆盖层；桌面为内联侧栏（宽度由外层网格列与拖拽共同决定）。
      className={cn(
        "relative h-full min-h-0 shrink-0 flex-col border-l bg-background/95",
        isDrawer
          ? "fixed inset-y-0 right-0 z-50 flex w-full border-l-0 shadow-2xl"
          : "hidden md:flex",
      )}
      style={isDrawer ? undefined : { width }}
      // 拖放事件就地消费并阻断冒泡，避免落入外层对话附件区。
      onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); setDropActive(true); }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDropActive(true); }}
      onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); if (event.currentTarget.contains(event.relatedTarget as Node | null) === false) setDropActive(false); }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        if (busy) return;
        void importDroppedFiles(event.dataTransfer.files);
      }}
    >
      {dropActive ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary">
          <FilePlus2 className="size-5" />
          <span>{dropTargetDirectory ? `松开以添加到 ${dropTargetDirectory}/` : "松开以导入项目工作区（ZIP 自动解压）"}</span>
        </div>
      ) : null}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Folder className="size-4" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-[0.14em]">Project Explorer</span>
        <Button variant="ghost" size="icon-sm" title={tWorkspace("newFile")} disabled={busy} onClick={() => onNewFile("")}><FilePlus2 /></Button>
        <Button variant="ghost" size="icon-sm" title={tWorkspace("importZip")} disabled={busy} onClick={() => archiveInputRef.current?.click()}><FileArchive /></Button>
        <Button variant="ghost" size="icon-sm" title={tWorkspace("downloadZip")} disabled={busy} onClick={() => void downloadArchive()}><FolderArchive /></Button>
        <Button variant="ghost" size="icon-sm" title={tWorkspace("refresh")} disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? "animate-spin" : ""} /></Button>
        <Button variant="ghost" size="icon-sm" title={tWorkspace("closeIDE")} onClick={onClose}><X /></Button>
      </header>
      <input
        ref={archiveInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importArchive(file);
        }}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn("overflow-auto p-2", changeGroups.length > 0 ? "shrink-0 border-b" : "min-h-0 flex-1")}
            style={changeGroups.length > 0 ? { height: treeHeight } : undefined}
            onClick={(event) => { if (event.target === event.currentTarget) setSelectedPaths(new Set()); }}
          >
            {workspaceTree.map((node) => node.kind === "directory" ? (
              <ContextMenu key={`dir-${node.path}`}>
                <ContextMenuTrigger asChild>
                  <div
                    {...directoryDropHandlers(node.path)}
                    className={cn(
                      "flex h-7 cursor-pointer select-none items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:bg-muted/60",
                      selectedPaths.has(node.path) && "bg-primary/15 text-primary",
                      dropTargetDirectory === node.path && "bg-primary/15 text-primary",
                    )}
                    style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) { event.stopPropagation(); toggleSelection(node.path); return; }
                      toggleDirectory(node.path);
                    }}
                    onContextMenu={() => ensureSelectionForContextMenu(node.path)}
                  >
                    {collapsedDirectories.has(node.path) ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
                    <Folder className="size-3.5 shrink-0" />
                    <span className="truncate">{node.label}</span>
                    <span className="ml-auto shrink-0 text-[10px] opacity-60">{node.count}</span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onNewFile(node.path)}>{tWorkspace("newFileIn", { name: node.label })}</ContextMenuItem>
                  <ContextMenuItem disabled={busy || selectedFileCount === 0} onClick={() => void removeSelected()}>{tWorkspace("deleteSelected", { count: selectedFileCount })}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => toggleDirectory(node.path)}>{collapsedDirectories.has(node.path) ? tWorkspace("expandFolder") : tWorkspace("collapseFolder")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ) : (
              <ContextMenu key={`file-${node.file.PublicID}`}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) { event.stopPropagation(); toggleSelection(node.file.RelativePath); return; }
                      onOpenFile(node.file);
                    }}
                    onContextMenu={() => ensureSelectionForContextMenu(node.file.RelativePath)}
                    className={cn(
                      "flex h-7 w-full items-center gap-2 rounded px-1.5 text-left text-xs hover:bg-muted",
                      selectedPaths.has(node.file.RelativePath) ? "bg-primary/15 text-primary" : activeTabPath === node.file.RelativePath && "bg-muted",
                    )}
                    style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
                  >
                    <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{node.label}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onOpenFile(node.file)}>{tWorkspace("openFile")}</ContextMenuItem>
                  <ContextMenuItem disabled={busy || selectedFileCount === 0} onClick={() => void removeSelected()}>{tWorkspace("deleteSelected", { count: selectedFileCount })}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onNewFile("")}>{tWorkspace("newFile")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setCollapsedDirectories(new Set(allDirectories))}>{tWorkspace("collapseAll")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setCollapsedDirectories(new Set())}>{tWorkspace("expandAll")}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={busy} onClick={() => void refresh()}>{tWorkspace("refresh")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {changeGroups.length > 0 ? (
        <>
          <div
            role="separator"
            aria-label="拖动调整文件列表高度"
            className="group relative z-10 h-1.5 shrink-0 cursor-row-resize touch-none"
            onPointerDown={onTreeResizeStart}
          >
            <div className="absolute inset-x-1 top-1/2 h-[2px] -translate-y-1/2 rounded bg-transparent group-hover:bg-primary/50" />
          </div>
          <section className="min-h-0 flex-1 overflow-auto p-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">对话变更</span>
              <span className="text-[10px] text-muted-foreground">{changeGroups.length} 轮</span>
            </div>
            {changeGroups.map((group) => {
              const expanded = expandedChangeGroups.has(group.messageKey);
              return (
                <div key={group.messageKey} className="mb-1">
                  <button
                    type="button"
                    onClick={() => setExpandedChangeGroups((previous) => {
                      const next = new Set(previous);
                      if (next.has(group.messageKey)) next.delete(group.messageKey);
                      else next.add(group.messageKey);
                      return next;
                    })}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
                    title={group.title}
                  >
                    {expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{group.title}</span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{group.changes.length}</span>
                  </button>
                  {expanded ? group.changes.map((change) => (
                    <button
                      key={change.key}
                      type="button"
                      onClick={() => onOpenChange(change)}
                      className="ml-3 mb-0.5 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left hover:bg-muted/60"
                    >
                      {change.name === "project_delete_file" ? <Trash2 className="size-3.5 text-destructive" /> : change.name === "project_create_archive" ? <FolderArchive className="size-3.5 text-muted-foreground" /> : <FileDiff className="size-3.5 text-muted-foreground" />}
                      <span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-medium">{change.name === "project_create_archive" ? "项目 ZIP 归档" : change.path}</span><span className="block truncate text-[10px] text-muted-foreground">{change.name === "project_create_archive" ? "点击下载" : change.parts && change.parts.length > 1 ? `${change.parts.length} 次修改 · 合并 Diff` : change.name.replace("project_", "")}</span></span>
                    </button>
                  )) : null}
                </div>
              );
            })}
          </section>
        </>
      ) : null}
    </aside>
  );
});
