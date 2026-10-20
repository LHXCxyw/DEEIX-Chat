"use client";

import * as React from "react";

import {
  fetchProjectFileBlob,
  fetchProjectFileContent,
  getProjectWorkspace,
  submitProjectPreviewResult,
} from "@/shared/api/conversation";
import type { ProjectWorkspaceFileDTO } from "@/shared/api/conversation-types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { blobToDataUrl, isBinaryAssetPath, type PreviewFileSource } from "@/shared/lib/project-preview-builder";

type ProjectPreviewReport = {
  conversationID: string;
  runID?: string;
  entryPath: string;
  console: string[];
  errors: string[];
};

/**
 * 登录态项目预览取数：把工作区清单/文本/二进制端点适配为构建器的 PreviewFileSource
 * （结果缓存于 ref，避免重复请求），并暴露运行结果回写。
 */
export function useChatProjectPreview(projectID: string) {
  const workspaceFilesRef = React.useRef<Map<string, ProjectWorkspaceFileDTO> | null>(null);
  const textCacheRef = React.useRef(new Map<string, string>());
  const dataUrlCacheRef = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    workspaceFilesRef.current = null;
    textCacheRef.current.clear();
    dataUrlCacheRef.current.clear();
  }, [projectID]);

  const source = React.useMemo<PreviewFileSource | null>(() => {
    if (!projectID) {
      return null;
    }
    const ensureWorkspaceFiles = async () => {
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
    };
    const readText = async (resolvedPath: string): Promise<string | null> => {
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
    };
    return {
      listFiles: async () => {
        const files = await ensureWorkspaceFiles();
        return files ? [...files.values()].map((file) => ({ path: file.RelativePath, mimeType: file.MimeType })) : [];
      },
      readText,
      readDataUrl: async (resolvedPath: string): Promise<string | null> => {
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
          const text = await readText(resolvedPath);
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
    };
  }, [projectID]);

  // 回写预览捕获的运行信息：无登录态时静默返回，异常由调用方按主流程决定是否吞掉。
  const submitResult = React.useCallback(async (report: ProjectPreviewReport) => {
    const token = await resolveAccessToken();
    if (!token) {
      return;
    }
    await submitProjectPreviewResult(token, report.conversationID, {
      runID: report.runID || undefined,
      entryPath: report.entryPath,
      console: report.console,
      errors: report.errors,
    });
  }, []);

  return { source, submitResult };
}
