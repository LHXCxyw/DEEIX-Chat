import { fetchFileContent } from "@/shared/api/file";
import { resolveApiBaseURL } from "@/shared/api/http-client";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

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

// 读取会话级缓存的缩略图地址；未命中返回 null，供组件初始化时同步展示已加载结果。
export function readCachedThumbnailURL(fileID: string): string | null {
  return thumbnailURLCache.get(fileID) ?? null;
}

// 鉴权拉取缩略图并转成 ObjectURL；同 fileID 的并发请求共享同一 Promise。
export async function loadThumbnailURL(fileID: string): Promise<string> {
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
export function resolveSignedThumbnailURL(signedPath: string): string {
  return `${resolveApiBaseURL()}${signedPath}`;
}
