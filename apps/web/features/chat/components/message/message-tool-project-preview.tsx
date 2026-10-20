"use client";

import { ChevronDown, ChevronRight, Play, RotateCw, Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { useChatProjectPreview } from "@/features/chat/hooks/use-chat-project-preview";
import { cn } from "@/lib/utils";
import { useTheme } from "@/shared/components/theme-provider";
import { captureHTMLVisualThemeSnapshot } from "@/shared/lib/html-visual-theme";
import { buildPreviewDocument, buildSandboxPreviewDocument } from "@/shared/lib/project-preview-builder";
import { SANDBOX_IFRAME_PERMISSIONS, SANDBOX_RUNTIME_REPORT_SOURCE } from "@/shared/lib/sandbox-document";

// 会话级去重：避免同一预览在页面重挂载后重复回写；「重新运行」会递增尝试序号从而允许再次回写。
const reportedPreviewKeys = new Set<string>();

const PREVIEW_SETTLE_MS = 1200;
const PREVIEW_LOAD_SETTLE_MS = 1600;
const PREVIEW_MAX_REPORT_LINES = 100;

type CapturedRuntime = {
  console: string[];
  errors: string[];
};

type RuntimeReportMessage = {
  source?: string;
  kind?: string;
  level?: string;
  text?: string;
};

function PreviewLines({ label, lines, failed }: { label: string; lines: string[]; failed?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/58">{label}</div>
      <pre
        className={cn(
          "max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-5 text-muted-foreground/88",
          failed && "bg-destructive/5 text-destructive/85",
        )}
      >
        {lines.join("\n")}
      </pre>
    </div>
  );
}

// 项目预览沙箱卡片：用登录态取数构建内联文档，在严格 CSP 的 iframe 中运行项目页面，
// 捕获 console 与运行时错误并回写后端，使模型下一轮可以读到运行情况。
export function ToolProjectPreviewCard({
  path,
  projectID,
  runID,
}: {
  path: string;
  projectID: string;
  runID?: string;
}) {
  const t = useTranslations("chat.processTrace.tool.preview");
  const { resolvedTheme } = useTheme();
  const entryPath = path.trim();
  const { source, submitResult } = useChatProjectPreview(projectID);

  const [conversationID, setConversationID] = React.useState("");
  const [doc, setDoc] = React.useState("");
  const [missing, setMissing] = React.useState<string[]>([]);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = React.useState(0);
  const [captured, setCaptured] = React.useState<CapturedRuntime>({ console: [], errors: [] });
  const [expanded, setExpanded] = React.useState(false);

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const captureRef = React.useRef<CapturedRuntime>({ console: [], errors: [] });
  const settleTimerRef = React.useRef<number | null>(null);
  const postedRef = React.useRef(false);
  const attemptRef = React.useRef(0);

  // 会话 id 取自路由查询参数；用 effect 读取以避免依赖 Suspense 边界。
  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    setConversationID((new URLSearchParams(window.location.search).get("conversation_id") ?? "").trim());
  }, []);

  // 回写捕获结果：去抖后仅执行一次，失败静默，不影响对话主流程。
  const finalize = React.useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (postedRef.current) {
      return;
    }
    if (!conversationID || !entryPath) {
      return;
    }
    postedRef.current = true;
    const snapshot = captureRef.current;
    const key = `${runID ?? ""}:${entryPath}:${attemptRef.current}`;
    if (reportedPreviewKeys.has(key)) {
      return;
    }
    reportedPreviewKeys.add(key);
    void (async () => {
      try {
        await submitResult({
          conversationID,
          runID,
          entryPath,
          console: snapshot.console.slice(0, PREVIEW_MAX_REPORT_LINES),
          errors: snapshot.errors.slice(0, PREVIEW_MAX_REPORT_LINES),
        });
      } catch {
        // 回写失败静默处理：捕获/回写异常不得影响对话主流程。
      }
    })();
  }, [conversationID, entryPath, runID, submitResult]);

  const scheduleFinalize = React.useCallback(
    (delay: number) => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = window.setTimeout(() => finalize(), delay);
    },
    [finalize],
  );

  // 用 ref 暴露最新的回写回调，使 postMessage 监听器只在挂载时绑定一次，
  // 避免会话 id 就绪导致的依赖变化在卸载清理时误触发回写。
  const finalizeRef = React.useRef(finalize);
  const scheduleFinalizeRef = React.useRef(scheduleFinalize);
  React.useEffect(() => {
    finalizeRef.current = finalize;
    scheduleFinalizeRef.current = scheduleFinalize;
  }, [finalize, scheduleFinalize]);

  // 监听沙箱 iframe 的 postMessage 上报：仅接受来自本卡片 iframe 且带来源标识的消息。
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) {
        return;
      }
      // Type assertion: MessageEvent.data 的类型是 any（DOM 规范如此），无法用类型守卫收窄；
      // 此处先按运行时上报消息的形状断言，再逐字段校验 source/text/kind。
      const data = event.data as RuntimeReportMessage | null;
      if (!data || data.source !== SANDBOX_RUNTIME_REPORT_SOURCE) {
        return;
      }
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        return;
      }
      const bucket = data.kind === "error" ? captureRef.current.errors : captureRef.current.console;
      bucket.push(text);
      setCaptured({ console: [...captureRef.current.console], errors: [...captureRef.current.errors] });
      scheduleFinalizeRef.current(PREVIEW_SETTLE_MS);
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      finalizeRef.current();
    };
  }, []);

  // 构建沙箱文档：内容变更或重新运行时重建（资源已缓存，重建为本地字符串操作）。
  React.useEffect(() => {
    if (!source || !entryPath) {
      setStatus("error");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    const theme = captureHTMLVisualThemeSnapshot(resolvedTheme === "dark" ? "dark" : "light");
    void (async () => {
      const content = await source.readText(entryPath).catch(() => null);
      if (cancelled) {
        return;
      }
      if (content === null) {
        setStatus("error");
        return;
      }
      try {
        const result = await buildPreviewDocument(content, entryPath, source, theme, { reportRuntime: true });
        if (cancelled) {
          return;
        }
        setDoc(result.doc);
        setMissing(result.missing);
        setStatus("ready");
      } catch {
        if (cancelled) {
          return;
        }
        setDoc(buildSandboxPreviewDocument(entryPath, content, theme, { reportRuntime: true }));
        setMissing([]);
        setStatus("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, entryPath, resolvedTheme]);

  const handleLoad = React.useCallback(() => {
    scheduleFinalize(PREVIEW_LOAD_SETTLE_MS);
  }, [scheduleFinalize]);

  const rerun = React.useCallback(() => {
    captureRef.current = { console: [], errors: [] };
    setCaptured({ console: [], errors: [] });
    postedRef.current = false;
    attemptRef.current += 1;
    setReloadKey((value) => value + 1);
  }, []);

  if (!entryPath) {
    return null;
  }

  const reportCount = captured.console.length + captured.errors.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
        <Terminal className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/78" title={entryPath}>
          {entryPath}
        </span>
        <Button variant="ghost" size="icon-sm" title={t("rerun")} aria-label={t("rerun")} onClick={rerun}>
          <RotateCw className="size-3.5" />
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border border-border/50 bg-white">
        {status === "error" ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">{t("unavailable")}</div>
        ) : status === "loading" ? (
          <div className="flex h-40 items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <Play className="size-3.5 animate-pulse" />
            {t("loading")}
          </div>
        ) : (
          // 沙箱 iframe：允许脚本运行但禁止同源访问；工作区相对资源已内联，运行信息经 postMessage 回传。
          <iframe
            key={reloadKey}
            ref={iframeRef}
            title={t("title", { path: entryPath })}
            srcDoc={doc}
            sandbox="allow-scripts"
            allow={SANDBOX_IFRAME_PERMISSIONS}
            referrerPolicy="no-referrer"
            onLoad={handleLoad}
            className="h-64 w-full border-0"
          />
        )}
      </div>
      {missing.length > 0 ? (
        <div className="text-[11px] text-muted-foreground/70" title={missing.join("\n")}>
          {t("missing", { count: missing.length })}
        </div>
      ) : null}
      <div className="rounded-md bg-background/48">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-muted-foreground/78 transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
          <span className="flex-1">{t("runtimeInfo")}</span>
          {reportCount > 0 ? <span className="shrink-0 tabular-nums">{reportCount}</span> : null}
        </button>
        {expanded ? (
          <div className="space-y-2 px-2 pb-2">
            {reportCount === 0 ? (
              <div className="text-[11px] text-muted-foreground/60">{t("empty")}</div>
            ) : (
              <>
                {captured.errors.length > 0 ? (
                  <PreviewLines label={t("errors")} lines={captured.errors} failed />
                ) : null}
                {captured.console.length > 0 ? <PreviewLines label={t("console")} lines={captured.console} /> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
