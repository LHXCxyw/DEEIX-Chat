"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Trash2, Server, Route, Pencil, PlugZap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { SpinnerLabel } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { COMPATIBLE_PRESETS } from "@/shared/lib/llm-presets";
import {
  listUserUpstreams,
  createUserUpstream,
  updateUserUpstream,
  deleteUserUpstream,
  testUserUpstream,
  listUserModels,
  type UserUpstreamDTO,
  type UserModelDTO,
} from "@/shared/api/user-upstream";
import { UserModelsDialog } from "./user-models-dialog";

type UpstreamForm = {
  name: string;
  baseURL: string;
  compatible: string;
  apiKey: string;
  connectTimeoutMS: string;
  readTimeoutMS: string;
  headers: string;
};

const EMPTY_UPSTREAM_FORM: UpstreamForm = {
  name: "",
  baseURL: "",
  compatible: "openai",
  apiKey: "",
  connectTimeoutMS: "10000",
  readTimeoutMS: "120000",
  headers: "",
};

function resolveErrorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 解析自定义请求头文本，空值返回 undefined，格式非法抛错 */
function parseHeaders(raw: string): Record<string, string> | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("自定义请求头必须是 JSON 对象");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    result[key] = String(value);
  }
  return result;
}

export function SettingsUpstreams() {
  const [items, setItems] = React.useState<UserUpstreamDTO[]>([]);
  const [models, setModels] = React.useState<UserModelDTO[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [disabled, setDisabled] = React.useState(false);
  const [testingID, setTestingID] = React.useState<number | null>(null);
  const [togglingID, setTogglingID] = React.useState<number | null>(null);

  const [upstreamDialogOpen, setUpstreamDialogOpen] = React.useState(false);
  const [editingUpstream, setEditingUpstream] = React.useState<UserUpstreamDTO | null>(null);
  const [upstreamForm, setUpstreamForm] = React.useState<UpstreamForm>(EMPTY_UPSTREAM_FORM);
  const [submitting, setSubmitting] = React.useState(false);

  const [modelsDialogOpen, setModelsDialogOpen] = React.useState(false);
  const [activeUpstream, setActiveUpstream] = React.useState<UserUpstreamDTO | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<UserUpstreamDTO | null>(null);
  const [deletingUpstream, setDeletingUpstream] = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const accessToken = await resolveAccessToken();
      const [upstreams, userModels] = await Promise.all([
        listUserUpstreams(accessToken),
        listUserModels(accessToken),
      ]);
      setItems(upstreams);
      setModels(userModels);
      setDisabled(false);
    } catch {
      setDisabled(true);
      setItems([]);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  function openCreateUpstream() {
    setEditingUpstream(null);
    setUpstreamForm(EMPTY_UPSTREAM_FORM);
    setUpstreamDialogOpen(true);
  }

  function openEditUpstream(item: UserUpstreamDTO) {
    setEditingUpstream(item);
    setUpstreamForm({
      name: item.name,
      baseURL: item.base_url,
      compatible: item.compatible || "openai",
      apiKey: "",
      connectTimeoutMS: String(item.connect_timeout_ms || 10000),
      readTimeoutMS: String(item.read_timeout_ms || 120000),
      headers: "",
    });
    setUpstreamDialogOpen(true);
  }

  async function handleSubmitUpstream() {
    if (!upstreamForm.name.trim() || !upstreamForm.baseURL.trim()) {
      toast.error("请填写渠道名称与接口地址");
      return;
    }
    if (!editingUpstream && !upstreamForm.apiKey.trim()) {
      toast.error("请填写 API 密钥");
      return;
    }
    let headers: Record<string, string> | undefined;
    try {
      headers = parseHeaders(upstreamForm.headers);
    } catch (error) {
      toast.error(resolveErrorText(error, "自定义请求头格式非法"));
      return;
    }
    setSubmitting(true);
    try {
      const accessToken = await resolveAccessToken();
      const payload = {
        name: upstreamForm.name.trim(),
        base_url: upstreamForm.baseURL.trim(),
        compatible: upstreamForm.compatible,
        connect_timeout_ms: Number(upstreamForm.connectTimeoutMS) || 10000,
        read_timeout_ms: Number(upstreamForm.readTimeoutMS) || 120000,
        ...(headers ? { headers } : {}),
      };
      if (editingUpstream) {
        await updateUserUpstream(accessToken, editingUpstream.id, {
          ...payload,
          ...(upstreamForm.apiKey.trim()
            ? { api_keys: [{ key: upstreamForm.apiKey.trim(), status: "active" }] }
            : {}),
        });
        toast.success("渠道已更新");
      } else {
        await createUserUpstream(accessToken, {
          ...payload,
          api_keys: [{ key: upstreamForm.apiKey.trim(), status: "active" }],
        });
        toast.success("渠道已创建，请继续导入模型");
      }
      setUpstreamDialogOpen(false);
      await reload();
    } catch (error) {
      toast.error(resolveErrorText(error, "保存渠道失败"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleUpstreamStatus(item: UserUpstreamDTO, nextActive: boolean) {
    setTogglingID(item.id);
    try {
      const accessToken = await resolveAccessToken();
      await updateUserUpstream(accessToken, item.id, { status: nextActive ? "active" : "inactive" });
      await reload();
    } catch (error) {
      toast.error(resolveErrorText(error, "更新渠道状态失败"));
    } finally {
      setTogglingID(null);
    }
  }

  async function handleTestUpstream(item: UserUpstreamDTO) {
    setTestingID(item.id);
    try {
      const accessToken = await resolveAccessToken();
      const result = await testUserUpstream(accessToken, item.id);
      if (result.ok) {
        toast.success(`连通正常，发现 ${result.modelCount} 个模型`, {
          description: `耗时 ${result.latencyMs} ms`,
        });
      } else {
        toast.error("连通失败", { description: result.message });
      }
    } catch (error) {
      toast.error(resolveErrorText(error, "测试失败"));
    } finally {
      setTestingID(null);
    }
  }

  async function handleDeleteUpstream() {
    if (!deleteTarget) return;
    setDeletingUpstream(true);
    try {
      const accessToken = await resolveAccessToken();
      await deleteUserUpstream(accessToken, deleteTarget.id);
      toast.success("渠道已删除");
      setDeleteTarget(null);
      await reload();
    } catch (error) {
      toast.error(resolveErrorText(error, "删除失败"));
    } finally {
      setDeletingUpstream(false);
    }
  }

  function openModelsDialog(item: UserUpstreamDTO) {
    setActiveUpstream(item);
    setModelsDialogOpen(true);
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (disabled) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        管理员未开启自有渠道功能
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">我的渠道与模型</h2>
          <p className="text-sm text-muted-foreground">渠道与模型仅对你自己生效，不会进入平台全局模型目录</p>
        </div>
        <Button size="sm" onClick={openCreateUpstream}>
          <Plus className="mr-1.5 size-4" />
          添加渠道
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          还没有添加任何渠道
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => {
            const upstreamModels = models.filter((model) => model.upstreamId === item.id);
            const activeCount = upstreamModels.filter((model) => model.status === "active").length;
            const isActive = item.status !== "inactive";
            return (
              <li key={item.id} className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Switch
                          size="sm"
                          checked={isActive}
                          disabled={togglingID === item.id}
                          onCheckedChange={(checked) => void handleToggleUpstreamStatus(item, checked)}
                          aria-label={`${item.name} 渠道开关`}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {isActive ? "点击停用该渠道" : "点击启用该渠道"}
                    </TooltipContent>
                  </Tooltip>
                  <Server className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{item.name}</p>
                      <Badge variant="secondary" className="text-[11px]">
                        {COMPATIBLE_PRESETS.find((preset) => preset.value === item.compatible)?.label ?? item.compatible}
                      </Badge>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {upstreamModels.length} 个模型 / {activeCount} 启用
                      </span>
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">{item.base_url}</p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={testingID === item.id}
                    onClick={() => void handleTestUpstream(item)}
                  >
                    <PlugZap className="mr-1.5 size-4" />
                    {testingID === item.id ? "测试中" : "测试"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openModelsDialog(item)}>
                    <Route className="mr-1.5 size-4" />
                    模型路由
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="编辑渠道" onClick={() => openEditUpstream(item)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="删除渠道" onClick={() => setDeleteTarget(item)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={upstreamDialogOpen} onOpenChange={setUpstreamDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editingUpstream ? "编辑渠道" : "添加渠道"}</DialogTitle>
            <DialogDescription>密钥仅用于你自己的请求，加密存储</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="user-upstream-name">渠道名称</Label>
              <Input
                id="user-upstream-name"
                value={upstreamForm.name}
                onChange={(event) => setUpstreamForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="user-upstream-base-url">接口地址</Label>
              <Input
                id="user-upstream-base-url"
                placeholder="https://api.openai.com/v1"
                value={upstreamForm.baseURL}
                onChange={(event) => setUpstreamForm((prev) => ({ ...prev, baseURL: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>兼容协议</Label>
              <Select
                value={upstreamForm.compatible}
                onValueChange={(value) => setUpstreamForm((prev) => ({ ...prev, compatible: value }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPATIBLE_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="user-upstream-key">API 密钥</Label>
              <Input
                id="user-upstream-key"
                type="password"
                placeholder={editingUpstream ? "留空表示不修改" : ""}
                value={upstreamForm.apiKey}
                onChange={(event) => setUpstreamForm((prev) => ({ ...prev, apiKey: event.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="user-upstream-connect">连接超时（毫秒）</Label>
                <Input
                  id="user-upstream-connect"
                  type="number"
                  min={1000}
                  value={upstreamForm.connectTimeoutMS}
                  onChange={(event) => setUpstreamForm((prev) => ({ ...prev, connectTimeoutMS: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="user-upstream-read">读取超时（毫秒）</Label>
                <Input
                  id="user-upstream-read"
                  type="number"
                  min={1000}
                  value={upstreamForm.readTimeoutMS}
                  onChange={(event) => setUpstreamForm((prev) => ({ ...prev, readTimeoutMS: event.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="user-upstream-headers">自定义请求头</Label>
              <Textarea
                id="user-upstream-headers"
                rows={3}
                placeholder='{"X-Custom-Header": "value"}'
                value={upstreamForm.headers}
                onChange={(event) => setUpstreamForm((prev) => ({ ...prev, headers: event.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUpstreamDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={submitting} onClick={() => void handleSubmitUpstream()}>
              {submitting ? <SpinnerLabel>保存中</SpinnerLabel> : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserModelsDialog
        open={modelsDialogOpen}
        onOpenChange={setModelsDialogOpen}
        upstream={activeUpstream}
        onChanged={() => void reload()}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(next) => !deletingUpstream && !next && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除渠道</AlertDialogTitle>
            <AlertDialogDescription>
              将同时删除该渠道下的所有模型路由，使用这些模型的对话将无法继续。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingUpstream}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletingUpstream}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteUpstream();
              }}
            >
              {deletingUpstream ? <SpinnerLabel>删除中</SpinnerLabel> : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
