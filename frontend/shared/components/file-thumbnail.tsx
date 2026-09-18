"use client";

import * as React from "react";

import { fetchFileContent } from "@/shared/api/file";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { resolveApiBaseURL } from "@/shared/api/http-client";
import { cn } from "@/lib/utils";

// 会话级缩略图缓存：fileID -> Blob ObjectURL，SPA 生命周期内复用；
// 签名直连路径不经此缓存（由 HTTP 缓存与 CDN 承担）。
const thumbnailURLCache = new Map<string, string>();
const thumbnailInflight = new Map<string, Promise<string>>();

// 鉴权 fetch 回退路径的并发闸门：签名未就绪（老 DTO）或签名加载失败时兜底，
// 限制并发避免列表页瞬间打满出口带宽。
const FETCH_CONCURRENCY = 4;
let fetchQueueActive = 0;
const fetchQueueWaiters: (() => void)[] = [];

async function acquireThumbnailSlot(): Promise<() => void> {
  if (fetchQueueActive >= FETCH_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      fetchQueueWaiters.push(resolve);
    });
  }
  fetchQueueActive += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    fetchQueueActive -= 1;
    const next = fetchQueueWaiters.shift();
    if (next) {
      next();
    }
  };
}

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
    const release = await acquireThumbnailSlot();
    try {
      const accessToken = await resolveAccessToken();
      if (!accessToken) {
        throw new Error("unauthorized");
      }
      const result = await fetchFileContent(accessToken, fileID);
      const objectURL = URL.createObjectURL(result.blob);
      thumbnailURLCache.set(fileID, objectURL);
      return objectURL;
    } finally {
      release();
    }
  })();
  thumbnailInflight.set(fileID, task);
  try {
    return await task;
  } finally {
    thumbnailInflight.delete(fileID);
  }
}

// resolveSignedThumbnailURL 将服务端签发的相对路径拼成完整直连地址。
function resolveSignedThumbnailURL(signedPath: string): string {
  return `${resolveApiBaseURL()}${signedPath}`;
}

type FileThumbnailProps = {
  fileID: string;
  alt: string;
  className?: string;
  // 服务端签发的 thumb 档直连地址；缺省时回退鉴权 fetch。
  signedURL?: string;
};

// 懒加载图片缩略图：进入视口（含预加载边距）才加载。
// 优先签名直连（<img> 由 HTTP/CDN 缓存），否则鉴权 fetch 全量（并发受限）。
// 加载失败时保持空容器，由调用方决定回退展示。
export function FileThumbnail({ fileID, alt, className, signedURL }: FileThumbnailProps) {
  const [objectURL, setObjectURL] = React.useState<string | null>(() => thumbnailURLCache.get(fileID) ?? null);
  const [visible, setVisible] = React.useState(Boolean(signedURL) || objectURL !== null);
  const containerRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (objectURL || signedURL) {
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
  }, [objectURL, signedURL]);

  React.useEffect(() => {
    if (!visible || objectURL || signedURL) {
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
  }, [visible, objectURL, signedURL, fileID]);

  const src = signedURL ? resolveSignedThumbnailURL(signedURL) : objectURL;

  return (
    <span ref={containerRef} aria-hidden="true" className={cn("block overflow-hidden rounded-[inherit]", className)}>
      {src ? <img src={src} alt={alt} className="size-full object-cover" /> : null}
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
