import type { User } from "@deeix/api-contract";
import { authedRequest } from "@/shared/api/authed-client";

// 画布快照的读写通道：服务端是唯一权威，updatedAt 由服务端生成，
// 客户端不得用本地时钟推断新旧（设备时钟偏差会导致误判覆盖）。
export type CanvasStateSnapshot = NonNullable<User.CanvasStateList.ResponseBody["data"]>;

export async function getCanvasState(accessToken: string): Promise<CanvasStateSnapshot> {
  return authedRequest<CanvasStateSnapshot>("/api/v1/user/canvas-state", { accessToken }, true);
}

export async function putCanvasState(
  accessToken: string,
  state: string,
): Promise<CanvasStateSnapshot> {
  const body: User.CanvasStateUpdate.RequestBody = { state };
  return authedRequest<CanvasStateSnapshot>(
    "/api/v1/user/canvas-state",
    {
      accessToken,
      method: "PUT",
      body: JSON.stringify(body),
    },
    true,
  );
}
