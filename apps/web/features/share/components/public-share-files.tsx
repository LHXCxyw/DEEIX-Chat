"use client";

import { ChevronDown, ChevronRight, FileCode2, Folder, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { PreviewText, resolveFilePreviewKind } from "@/entities/file";
import { useShareProjectFiles } from "@/features/share/hooks/use-share-project-files";
import { cn } from "@/lib/utils";
import type { PublicSharedProjectFileDTO } from "@/shared/api/conversation-types";
import { useTheme } from "@/shared/components/theme-provider";
import { captureHTMLVisualThemeSnapshot } from "@/shared/lib/html-visual-theme";
import {
  buildPreviewDocument,
  buildSandboxPreviewDocument,
  isPreviewableFile,
  type PreviewFileSource,
} from "@/shared/lib/project-preview-builder";
import { SANDBOX_IFRAME_PERMISSIONS } from "@/shared/lib/sandbox-document";

// 分享页只读文件区：展示分享快照内冻结的项目文件树，点击文件后预览。
// HTML/SVG 走沙箱 iframe（相对资源内联后可运行），图片/视频直连公开内容端点，文本只读展示。
// 快照为空（会话未绑定项目或无文件）时不渲染。

type TreeRow =
  | { kind: "directory"; path: string; label: string; depth: number; count: number }
  | { kind: "file"; depth: number; file: PublicSharedProjectFileDTO };

type DirectoryNode = {
  dirs: Map<string, DirectoryNode>;
  files: Map<string, PublicSharedProjectFileDTO>;
  count: number;
};

// 递归构建文件树并按 DFS 展平：目录在文件之前、同级按名称排序。
function buildTree(files: PublicSharedProjectFileDTO[], collapsed: Set<string>): TreeRow[] {
  const root: DirectoryNode = { dirs: new Map(), files: new Map(), count: 0 };
  for (const file of files) {
    if (file.entryType !== "file") {
      continue;
    }
    const parts = file.relativePath.split("/").filter(Boolean);
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
    current.files.set(file.relativePath, file);
  }
  const rows: TreeRow[] = [];
  const walk = (node: DirectoryNode, depth: number) => {
    const dirs = [...node.dirs.entries()].sort((left, right) => left[0].localeCompare(right[0]));
    const fileRows = [...node.files.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
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
      rows.push({ kind: "file", depth, file });
    }
  };
  walk(root, 0);
  return rows;
}

type PreviewState =
  | { status: "loading" }
  | { status: "doc"; doc: string; missing: string[] }
  | { status: "media"; mediaKind: "image" | "video" }
  | { status: "text"; content: string; kind: "markdown" | "code" | "text" }
  | { status: "unsupported" }
  | { status: "error" };

function SharedFilePreview({
  file,
  previewSource,
  contentURL,
  fetchContent,
}: {
  file: PublicSharedProjectFileDTO;
  previewSource: PreviewFileSource;
  contentURL: (filePublicID: string) => string;
  fetchContent: (filePublicID: string) => Promise<string>;
}) {
  const t = useTranslations("share");
  const { resolvedTheme } = useTheme();
  const [state, setState] = React.useState<PreviewState>({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const path = file.relativePath;
    const theme = captureHTMLVisualThemeSnapshot(resolvedTheme === "dark" ? "dark" : "light");

    // HTML/SVG：内联相对引用的项目资源后放入沙箱 iframe，允许脚本运行但禁止同源访问。
    if (isPreviewableFile(path)) {
      const timer = window.setTimeout(() => {
        void fetchContent(file.publicID)
          .then(async (content) => {
            if (cancelled) {
              return;
            }
            try {
              const result = await buildPreviewDocument(content, path, previewSource, theme);
              if (!cancelled) {
                setState({ status: "doc", doc: result.doc, missing: result.missing });
              }
            } catch {
              if (!cancelled) {
                setState({ status: "doc", doc: buildSandboxPreviewDocument(path, content, theme), missing: [] });
              }
            }
          })
          .catch(() => {
            if (!cancelled) {
              setState({ status: "error" });
            }
          });
      }, 200);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    const kind = resolveFilePreviewKind({ fileName: file.fileName, mimeType: file.mimeType }, file.mimeType);
    if (kind === "image" || kind === "video") {
      setState({ status: "media", mediaKind: kind });
      return () => {
        cancelled = true;
      };
    }
    if (kind === "markdown" || kind === "code" || kind === "text") {
      void fetchContent(file.publicID)
        .then((content) => {
          if (!cancelled) {
            setState({ status: "text", content, kind });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setState({ status: "error" });
          }
        });
      return () => {
        cancelled = true;
      };
    }
    setState({ status: "unsupported" });
    return () => {
      cancelled = true;
    };
  }, [contentURL, fetchContent, file, previewSource, resolvedTheme]);

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("previewLoading")}
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t("previewFailed")}</div>;
  }
  if (state.status === "unsupported") {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t("previewUnavailable")}</div>
    );
  }
  if (state.status === "media") {
    const url = contentURL(file.publicID);
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-3">
        {state.mediaKind === "image" ? (
          <img src={url} alt={file.fileName} className="max-h-full max-w-full object-contain" />
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: 分享项目视频无字幕轨道，仅提供只读播放
          <video src={url} controls className="max-h-full max-w-full rounded-md" />
        )}
      </div>
    );
  }
  if (state.status === "text") {
    return (
      <div className="h-full min-h-0 overflow-auto p-3">
        <PreviewText kind={state.kind} content={state.content} className="min-h-0" />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {state.missing.length > 0 ? (
        <div
          className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground"
          title={state.missing.join("\n")}
        >
          {t("unresolvedResources", { items: state.missing.slice(0, 4).join("、") })}
          {state.missing.length > 4 ? t("unresolvedMore", { count: state.missing.length }) : ""}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 bg-white">
        <iframe
          title={t("previewTitle", { path: file.relativePath })}
          srcDoc={state.doc}
          allow={SANDBOX_IFRAME_PERMISSIONS}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0"
        />
      </div>
    </div>
  );
}

export function PublicShareFiles({ shareID }: { shareID: string }) {
  const t = useTranslations("share");
  const { files, previewSource, contentURL, fetchContent } = useShareProjectFiles(shareID);
  const [expanded, setExpanded] = React.useState(false);
  const [collapsedDirectories, setCollapsedDirectories] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<PublicSharedProjectFileDTO | null>(null);

  // 分享标识切换时重置本地选中态与目录折叠态（文件清单由 hook 重新拉取）。
  React.useEffect(() => {
    setSelected(null);
    setCollapsedDirectories(new Set());
  }, [shareID]);

  const tree = React.useMemo(() => buildTree(files ?? [], collapsedDirectories), [files, collapsedDirectories]);

  // 快照为空时不渲染文件区（保持分享页原状）。
  if (!files || files.length === 0) {
    return null;
  }

  const toggleDirectory = (directory: string) => {
    setCollapsedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(directory)) {
        next.delete(directory);
      } else {
        next.add(directory);
      }
      return next;
    });
  };

  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-border/60 bg-background/60">
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? t("filesCollapse") : t("filesExpand")}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <Folder className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-[0.14em]">{t("files")}</span>
        <span className="text-[10px] text-muted-foreground">{t("filesCount", { count: files.length })}</span>
        <span className="ml-auto text-muted-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      </button>
      {expanded ? (
        <div
          className="grid min-h-[360px] border-t border-border/60"
          style={{ gridTemplateColumns: "minmax(0, 240px) minmax(0, 1fr)" }}
        >
          <div className="min-h-0 overflow-auto border-r border-border/60 p-2">
            {tree.map((node) =>
              node.kind === "directory" ? (
                <button
                  key={`dir-${node.path}`}
                  type="button"
                  onClick={() => toggleDirectory(node.path)}
                  className="flex h-7 w-full items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                  style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
                >
                  {collapsedDirectories.has(node.path) ? (
                    <ChevronRight className="size-3 shrink-0" />
                  ) : (
                    <ChevronDown className="size-3 shrink-0" />
                  )}
                  <Folder className="size-3.5 shrink-0" />
                  <span className="truncate">{node.label}</span>
                  <span className="ml-auto shrink-0 text-[10px] opacity-60">{node.count}</span>
                </button>
              ) : (
                <button
                  key={`file-${node.file.publicID}`}
                  type="button"
                  onClick={() => setSelected(node.file)}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded px-1.5 text-left text-xs transition-colors hover:bg-muted",
                    selected?.publicID === node.file.publicID && "bg-muted text-foreground",
                  )}
                  style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
                >
                  <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{node.file.fileName}</span>
                </button>
              ),
            )}
          </div>
          <div className="min-h-0 overflow-hidden">
            {selected ? (
              <SharedFilePreview
                file={selected}
                previewSource={previewSource}
                contentURL={contentURL}
                fetchContent={fetchContent}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("previewSelect")}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
