"use client";

import * as React from "react";

import { getSharedProjectFiles } from "@/shared/api/conversation";
import type { PublicSharedProjectFileDTO } from "@/shared/api/conversation-types";
import {
  fetchSharedProjectFileBlob,
  fetchSharedProjectFileContent,
  sharedProjectFileContentURL,
} from "@/shared/api/file";
import { blobToDataUrl, isBinaryAssetPath, type PreviewFileSource } from "@/shared/lib/project-preview-builder";

/**
 * 加载公开分享快照内冻结的项目文件清单，并把分享域的文本/二进制取数端点适配为
 * 预览构建器的 PreviewFileSource；同时暴露媒体直连地址与文本取数，供预览组件消费。
 */
export function useShareProjectFiles(shareID: string) {
  const [files, setFiles] = React.useState<PublicSharedProjectFileDTO[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setFiles(null);
    getSharedProjectFiles(shareID)
      .then((result) => {
        if (!cancelled) {
          setFiles(result.files ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shareID]);

  const previewSource = React.useMemo<PreviewFileSource>(() => {
    const byPath = new Map((files ?? []).map((file) => [file.relativePath, file]));
    const textCache = new Map<string, string>();
    const dataUrlCache = new Map<string, string>();
    // 读取分享域文本资源（CSS/JS 等），未命中缓存返回 null。
    const readText = async (path: string): Promise<string | null> => {
      const cached = textCache.get(path);
      if (cached !== undefined) {
        return cached || null;
      }
      const file = byPath.get(path);
      if (!file) {
        textCache.set(path, "");
        return null;
      }
      const text = await fetchSharedProjectFileContent(shareID, file.publicID).catch(() => null);
      textCache.set(path, text ?? "");
      return text;
    };
    return {
      listFiles: async () => [...byPath.values()].map((file) => ({ path: file.relativePath, mimeType: file.mimeType })),
      readText,
      // 读取分享域资源并转为 data URL（图片/字体/SVG），用于 img src 与 CSS url()。
      readDataUrl: async (path: string): Promise<string | null> => {
        const cached = dataUrlCache.get(path);
        if (cached !== undefined) {
          return cached || null;
        }
        const file = byPath.get(path);
        if (!file) {
          dataUrlCache.set(path, "");
          return null;
        }
        let dataUrl = "";
        if (path.toLowerCase().endsWith(".svg")) {
          const text = await readText(path);
          if (text) {
            dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(text)}`;
          }
        } else if (isBinaryAssetPath(path)) {
          const blob = await fetchSharedProjectFileBlob(shareID, file.publicID).catch(() => null);
          if (blob) {
            dataUrl = await blobToDataUrl(blob).catch(() => "");
          }
        }
        dataUrlCache.set(path, dataUrl);
        return dataUrl || null;
      },
    };
  }, [files, shareID]);

  const contentURL = React.useCallback(
    (filePublicID: string) => sharedProjectFileContentURL(shareID, filePublicID),
    [shareID],
  );
  const fetchContent = React.useCallback(
    (filePublicID: string) => fetchSharedProjectFileContent(shareID, filePublicID),
    [shareID],
  );

  return { files, previewSource, contentURL, fetchContent };
}
