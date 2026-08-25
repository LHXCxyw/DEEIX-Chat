import { authedRequest } from "@/shared/api/authed-client";
import { pathParam } from "@/shared/api/http-client";

/** 用户自有渠道（BYOK）视图对象 */
export interface UserUpstreamDTO {
  id: number;
  name: string;
  base_url: string;
  compatible: string;
  status: string;
  billing_mode: string;
  connect_timeout_ms: number;
  read_timeout_ms: number;
  created_at: string;
  updated_at: string;
}

/** 创建用户自有渠道请求体 */
export interface CreateUserUpstreamPayload {
  name: string;
  base_url: string;
  compatible: string;
  api_keys: Array<{ key: string; status?: string; note?: string }>;
  connect_timeout_ms?: number;
  read_timeout_ms?: number;
  headers?: Record<string, string>;
}

/** 更新用户自有渠道请求体，未传字段保持原值 */
export type UpdateUserUpstreamPayload = Partial<CreateUserUpstreamPayload> & {
  status?: string;
};

export interface UserRemoteModelsDTO {
  items: string[];
  total: number;
}

export interface UserModelDTO {
  id: number;
  ownerUserId: number;
  upstreamId: number;
  upstreamName: string;
  upstreamCompatible: string;
  upstreamModelId: string;
  name: string;
  protocol: string;
  kinds: string;
  status: string;
  priority: number;
  weight: number;
  headers: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserModelPayload {
  upstreamModelId: string;
  name: string;
  protocol: string;
  kinds?: string;
  status?: string;
  priority?: number;
  weight?: number;
  headers?: string;
}

export type UpdateUserModelPayload = Partial<CreateUserModelPayload>;

/** 用户渠道连通性测试结果 */
export interface UserUpstreamTestResult {
  ok: boolean;
  modelCount: number;
  latencyMs: number;
  message?: string;
}

/** 用户模型批量创建结果 */
export interface BatchCreateUserModelsResult {
  items: UserModelDTO[];
  successCount: number;
  failed: string[];
  failedCount: number;
}

export async function testUserUpstream(accessToken: string, upstreamID: number): Promise<UserUpstreamTestResult> {
  return authedRequest<UserUpstreamTestResult>(`/api/v1/user/upstreams/${pathParam(String(upstreamID))}/test`, {
    method: "POST",
    accessToken,
  });
}

export async function batchCreateUserModels(
  accessToken: string,
  upstreamID: number,
  items: CreateUserModelPayload[],
): Promise<BatchCreateUserModelsResult> {
  return authedRequest<BatchCreateUserModelsResult>(`/api/v1/user/upstreams/${pathParam(String(upstreamID))}/models/batch`, {
    method: "POST",
    accessToken,
    body: { items },
  });
}

/** 用户模型批量操作结果 */
export interface UserModelBatchResult {
  successCount: number;
  failed: number[];
  failedCount: number;
}

/** 用户模型探测结果 */
export interface UserModelProbeResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

export async function batchUpdateUserModels(
  accessToken: string,
  ids: number[],
  patch: UpdateUserModelPayload,
): Promise<UserModelBatchResult> {
  return authedRequest<UserModelBatchResult>("/api/v1/user/models/batch-update", {
    method: "POST",
    accessToken,
    body: { ids, patch },
  });
}

export async function batchDeleteUserModels(accessToken: string, ids: number[]): Promise<UserModelBatchResult> {
  return authedRequest<UserModelBatchResult>("/api/v1/user/models/batch-delete", {
    method: "POST",
    accessToken,
    body: { ids },
  });
}

export async function testUserModel(accessToken: string, id: number): Promise<UserModelProbeResult> {
  return authedRequest<UserModelProbeResult>(`/api/v1/user/models/${pathParam(String(id))}/test`, {
    method: "POST",
    accessToken,
  });
}

export async function listUserRemoteModels(accessToken: string, upstreamID: number): Promise<string[]> {
  const data = await authedRequest<UserRemoteModelsDTO>(`/api/v1/user/upstreams/${pathParam(String(upstreamID))}/models/remote`, {
    method: "GET",
    accessToken,
  });
  return data?.items ?? [];
}

export async function listUserModels(accessToken: string): Promise<UserModelDTO[]> {
  const data = await authedRequest<{ items: UserModelDTO[] }>("/api/v1/user/models", {
    method: "GET",
    accessToken,
  });
  return data?.items ?? [];
}

export async function createUserModel(accessToken: string, upstreamID: number, payload: CreateUserModelPayload): Promise<UserModelDTO> {
  return authedRequest<UserModelDTO>(`/api/v1/user/upstreams/${pathParam(String(upstreamID))}/models`, {
    method: "POST",
    accessToken,
    body: payload,
  });
}

export async function updateUserModel(accessToken: string, id: number, payload: UpdateUserModelPayload): Promise<UserModelDTO> {
  return authedRequest<UserModelDTO>(`/api/v1/user/models/${pathParam(String(id))}`, {
    method: "PATCH",
    accessToken,
    body: payload,
  });
}

export async function deleteUserModel(accessToken: string, id: number): Promise<{ message: string }> {
  return authedRequest<{ message: string }>(`/api/v1/user/models/${pathParam(String(id))}`, {
    method: "DELETE",
    accessToken,
  });
}

export async function listUserUpstreams(accessToken: string): Promise<UserUpstreamDTO[]> {
  const data = await authedRequest<{ items: UserUpstreamDTO[] }>("/api/v1/user/upstreams", {
    method: "GET",
    accessToken,
  });
  return data?.items ?? [];
}

export async function createUserUpstream(
  accessToken: string,
  payload: CreateUserUpstreamPayload,
): Promise<UserUpstreamDTO> {
  return authedRequest<UserUpstreamDTO>("/api/v1/user/upstreams", {
    method: "POST",
    accessToken,
    body: payload,
  });
}

export async function updateUserUpstream(
  accessToken: string,
  id: number,
  payload: UpdateUserUpstreamPayload,
): Promise<{ message: string }> {
  return authedRequest<{ message: string }>(`/api/v1/user/upstreams/${pathParam(String(id))}`, {
    method: "PATCH",
    accessToken,
    body: payload,
  });
}

export async function deleteUserUpstream(
  accessToken: string,
  id: number,
): Promise<{ message: string }> {
  return authedRequest<{ message: string }>(`/api/v1/user/upstreams/${pathParam(String(id))}`, {
    method: "DELETE",
    accessToken,
  });
}
