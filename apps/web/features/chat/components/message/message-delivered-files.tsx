"use client";

import { Download, FileText, FolderArchive } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatBytes } from "@/entities/file";
import type { DeliveredFile, DeliveredFilesPayload } from "@/features/chat/model/delivered-files";
import { resolveApiBaseURL } from "@/shared/api/http-client";
import { cn } from "@/lib/utils";

// 下载地址可能是绝对链接，也可能是后端未配置公开域名时的相对路径；
// 相对路径统一拼上当前 API base，避免新窗口打开到前端路由。
function downloadHref(downloadUrl: string, apiBaseURL: string): string {
  if (!downloadUrl) {
    return "";
  }
  if (/^https?:\/\//i.test(downloadUrl)) {
    return downloadUrl;
  }
  if (!apiBaseURL) {
    return downloadUrl;
  }
  return `${apiBaseURL.replace(/\/+$/, "")}${downloadUrl.startsWith("/") ? "" : "/"}${downloadUrl}`;
}

function DownloadLink({
  href,
  label,
  strong,
}: {
  href: string;
  label: string;
  strong?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      download
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
        strong
          ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
          : "border-border/70 bg-background/60 text-foreground hover:bg-muted",
      )}
    >
      <Download className="size-3" />
      {label}
    </a>
  );
}

function FileRow({ file, apiBaseURL, label }: { file: DeliveredFile; apiBaseURL: string; label: string }) {
  const href = downloadHref(file.downloadUrl, apiBaseURL);
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs" title={file.path}>
        {file.fileName}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
      {href ? <DownloadLink href={href} label={label} /> : null}
    </div>
  );
}

// 消息内的文件交付卡片：逐文件下载 + 目录/多文件整包下载。
export function MessageDeliveredFiles({ payload }: { payload: DeliveredFilesPayload }) {
  const t = useTranslations("chat.workspace");
  const apiBaseURL = resolveApiBaseURL();
  const archiveHref = payload.archive ? downloadHref(payload.archive.downloadUrl, apiBaseURL) : "";
  if (payload.files.length === 0 && !archiveHref) {
    return null;
  }

  return (
    <div className="my-3 w-full max-w-[34rem] rounded-lg border border-border/70 bg-muted/20 p-2.5">
      <div className="flex items-center gap-2 px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Download className="size-3.5" />
        <span>{t("deliveryTitle")}</span>
        <span className="ml-auto normal-case tracking-normal text-[10px] font-normal">{t("deliveryExpires")}</span>
      </div>

      <div className="space-y-0.5">
        {payload.files.map((file) => (
          <FileRow key={file.key} file={file} apiBaseURL={apiBaseURL} label={t("deliveryDownload")} />
        ))}
      </div>

      {payload.truncated ? (
        <p className="px-2 pt-1 text-[10px] text-muted-foreground">
          {t("deliveryFileCount", { count: payload.files.length })}
        </p>
      ) : null}

      {payload.archive && archiveHref ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2 py-1.5">
          <FolderArchive className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs" title={payload.archive.fileName}>
            {payload.archive.fileName}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {t("deliveryFileCount", { count: payload.archive.fileCount })} · {formatBytes(payload.archive.totalBytes)}
          </span>
          <DownloadLink href={archiveHref} label={t("deliveryPackage")} strong />
        </div>
      ) : null}
    </div>
  );
}
