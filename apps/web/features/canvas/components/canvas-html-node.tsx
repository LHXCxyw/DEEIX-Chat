"use client";

import { Code2, Eye, FileCode2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { GraphNodeShell } from "@/features/canvas/components/canvas-graph-node-shell";
import type { GraphNodeActionHandlers } from "@/features/canvas/components/canvas-graph-nodes";
import { graphNodeSize, type HtmlGraphNode } from "@/features/canvas/model/canvas-types";
import { useTheme } from "@/shared/components/theme-provider";
import {
  captureHTMLVisualThemeSnapshot,
  type HTMLVisualThemeSnapshot,
} from "@/shared/lib/html-visual-theme";
import { SANDBOX_IFRAME_PERMISSIONS, sandboxDocumentHead } from "@/shared/lib/sandbox-document";
import { cn } from "@/lib/utils";

// 节点内代码 / 预览两页切换
type HtmlNodeMode = "code" | "preview";

// ---------------------------------------------------------------------------
// HTML 预览节点：可编写 HTML/CSS/JS 并在画布内以沙箱 iframe 实时预览（独立节点，不参与连线）
// ---------------------------------------------------------------------------
export function HtmlGraphNodeView({
  node,
  selected,
  compatible,
  handlers,
}: {
  node: HtmlGraphNode;
  selected: boolean;
  compatible: boolean;
  handlers: GraphNodeActionHandlers;
}) {
  const t = useTranslations("canvas");
  const size = graphNodeSize(node);
  const [mode, setMode] = React.useState<HtmlNodeMode>("code");
  const { resolvedTheme } = useTheme();
  // 主题快照只在挂载后经 getComputedStyle 采集一次（渲染期不可读取计算样式），首帧后缓存
  const [themeSnapshot, setThemeSnapshot] = React.useState<HTMLVisualThemeSnapshot | null>(null);

  React.useEffect(() => {
    if (themeSnapshot) {
      return;
    }
    setThemeSnapshot(captureHTMLVisualThemeSnapshot(resolvedTheme));
  }, [resolvedTheme, themeSnapshot]);

  // 仅在 HTML 源码或首次主题快照就绪时重建 iframe 文档，避免每次按键都重载导致闪烁
  const srcDoc = React.useMemo(
    () => (themeSnapshot
      ? `<!doctype html><html><head>${sandboxDocumentHead("Canvas HTML", themeSnapshot)}</head><body>${node.html}</body></html>`
      : ""),
    [node.html, themeSnapshot],
  );

  const stopPointer = (event: React.PointerEvent) => event.stopPropagation();

  const tabButton = (target: HtmlNodeMode, label: string, Icon: typeof Code2) => (
    <button
      type="button"
      data-canvas-selectable
      aria-pressed={mode === target}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors",
        mode === target ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onPointerDown={stopPointer}
      onClick={() => setMode(target)}
    >
      <Icon className="size-3" strokeWidth={1.8} />
      {label}
    </button>
  );

  return (
    <GraphNodeShell
      nodeID={node.id}
      kind="html"
      title={t("nodeKindHtml")}
      icon={<FileCode2 className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
      width={size.width}
      height={size.height}
      selected={selected}
      compatible={compatible}
      onRemove={() => handlers.onRemoveNode(node.id)}
      removeLabel={t("nodeDelete")}
    >
      <div className="flex h-full flex-col gap-1.5 p-2.5">
        {/* 代码 / 预览切换 */}
        <div className="flex shrink-0 items-center gap-1">
          {tabButton("code", t("htmlTabCode"), Code2)}
          {tabButton("preview", t("htmlTabPreview"), Eye)}
        </div>

        {mode === "code" ? (
          <textarea
            data-canvas-selectable
            value={node.html}
            onChange={(event) => handlers.onUpdateNode(node.id, { html: event.target.value })}
            placeholder={t("htmlPlaceholder")}
            spellCheck={false}
            className="min-h-0 w-full flex-1 resize-none rounded-lg border border-border/50 bg-background/50 p-2 font-mono text-[10px] leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
          />
        ) : (
          <div
            data-canvas-selectable
            className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-background"
          >
            {node.html.trim() ? (
              <iframe
                title={t("nodeKindHtml")}
                sandbox="allow-scripts"
                allow={SANDBOX_IFRAME_PERMISSIONS}
                referrerPolicy="no-referrer"
                srcDoc={srcDoc}
                className="size-full border-0 bg-transparent"
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-1.5 text-muted-foreground/60">
                <FileCode2 className="size-5" strokeWidth={1.6} />
                <p className="px-4 text-center text-[11px] leading-relaxed">{t("htmlEmptyHint")}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </GraphNodeShell>
  );
}
