"use client";

import * as React from "react";

import { fetchFileContent } from "@/shared/api/file";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { cn } from "@/lib/utils";

// 会话级缩略图缓存：fileID -> Blob ObjectURL，SPA 生命周期内复用；
// 页面刷新后由 HTTP 缓存兜底（生成产物带 immutable 长缓存）
const thumbnailURLCache = new Map<string, string>();
const thumbnailInflight = new Map<string, Promise<string>>();

async function loadThumbnailURL(fileID: string): Promise<string> {
  const cached = thumbnailURLCache.get(fileID);
  if (cached) {
    return cached;
  }
  const pending = thumbnailInflight.get(fileID);
  if (pending) {
    return pending;
  }
  const task = (async () => {
    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      throw new Error("unauthorized");
    }
    const result = await fetchFileContent(accessToken, fileID);
    const objectURL = URL.createObjectURL(result.blob);
    thumbnailURLCache.set(fileID, objectURL);
    return objectURL;
  })();
  thumbnailInflight.set(fileID, task);
  try {
    return await task;
  } finally {
    thumbnailInflight.delete(fileID);
  }
}

type FileThumbnailProps = {
  fileID: string;
  alt: string;
  className?: string;
};

// 懒加载图片缩略图：进入视口（含预加载边距）才拉取文件内容。
// 加载失败时保持空容器，由调用方决定回退展示。
export function FileThumbnail({ fileID, alt, className }: FileThumbnailProps) {
  const [objectURL, setObjectURL] = React.useState<string | null>(() => thumbnailURLCache.get(fileID) ?? null);
  const [visible, setVisible] = React.useState(objectURL !== null);
  const containerRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (objectURL) {
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "256px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [objectURL]);

  React.useEffect(() => {
    if (!visible || objectURL) {
      return;
    }
    let cancelled = false;
    void loadThumbnailURL(fileID)
      .then((nextURL) => {
        if (!cancelled) {
          setObjectURL(nextURL);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [visible, objectURL, fileID]);

  return (
    <span ref={containerRef} aria-hidden="true" className={cn("block overflow-hidden rounded-[inherit]", className)}>
      {objectURL ? <img src={objectURL} alt={alt} className="size-full object-cover" /> : null}
    </span>
  );
}

// 可出缩略图的文件判断：仅位图类图片；SVG 服务端会改写为 text/plain 无法作为图片渲染
export function canShowFileThumbnail(fileCategory: string, mimeType: string): boolean {
  if (fileCategory !== "image") {
    return false;
  }
  return !mimeType.toLowerCase().includes("svg");
}
