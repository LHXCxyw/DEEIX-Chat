"use client";

import * as React from "react";
import { toast } from "sonner";
import { CloudDownload, Search, ToggleLeft, Cable, Tags, Trash2, Activity } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SpinnerLabel } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableEmptyRow,
  TableHead,
  TableHeader,
  TableLoadingRow,
  TableRow,
} from "@/components/ui/table";
import { TablePagination, TableToolbar } from "@/components/ui/table-tools";
import { useVirtualTableRows, VirtualTablePaddingRow } from "@/components/ui/virtual-table";
import { cn } from "@/lib/utils";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { PROTOCOL_PRESETS, DEFAULT_PROTOCOL_BY_COMPATIBLE } from "@/shared/lib/llm-presets";
import {
  listUserModels,
  listUserRemoteModels,
  batchCreateUserModels,
  createUserModel,
  batchUpdateUserModels,
  batchDeleteUserModels,
  testUserModel,
  updateUserModel,
  type UserModelDTO,
  type UserUpstreamDTO,
} from "@/shared/api/user-upstream";
import { UserKindsDropdown, UserProtocolDropdown } from "./user-model-dropdowns";

type UserRowDraft = UserModelDTO & {
  isDirty: boolean;
  nameDraft: string;
  kindsDisplay: string;
};

type RowPatch = Partial<Pick<UserRowDraft, "nameDraft" | "protocol" | "kindsDisplay" | "status" | "priority" | "weight">>;

type StatusFilter = "" | "active" | "disabled";
type SortValue = "upstream_asc" | "upstream_desc" | "name_asc" | "name_desc" | "status_asc" | "protocol_asc";

const PAGE_SIZE_DEFAULT = 25;

function kindsJsonToDisplay(kindsJson: string): string {
  if (!kindsJson) return "chat";
  try {
    const parsed: unknown = JSON.parse(kindsJson);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((item) => String(item)).join(",");
    }
  } catch {
    // 解析失败按默认能力处理
  }
  return "chat";
}

function displayToKindsJson(display: string): string {
  const kinds = display.split(",").map((item) => item.trim()).filter(Boolean);
  return JSON.stringify(kinds.length > 0 ? kinds : ["chat"]);
}

function toRowDraft(item: UserModelDTO): UserRowDraft {
  return { ...item, isDirty: false, nameDraft: item.name, kindsDisplay: kindsJsonToDisplay(item.kinds) };
}

function resolveErrorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isDuplicateModelError(error: unknown): boolean {
  return error instanceof Error && /user model already exists/i.test(error.message);
}

type ModelRowProps = {
  row: UserRowDraft;
  isSelected: boolean;
  upstreamInactive: boolean;
  onSelect: (id: number, checked: boolean) => void;
  onUpdate: (id: number, patch: RowPatch) => void;
  onTest: (row: UserRowDraft) => void;
};

const ModelRow = React.memo(function ModelRow({
  row,
  isSelected,
  upstreamInactive,
  onSelect,
  onUpdate,
  onTest,
}: ModelRowProps) {
  const routeChecked = !upstreamInactive && row.status === "active";
  const testDisabled = row.isDirty;

  return (
    <TableRow selected={isSelected} tone={row.isDirty ? "warning" : undefined}>
      <TableCell className="w-[44px] py-1.5 text-center whitespace-nowrap">
        <div className="flex h-7 items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onSelect(row.id, checked === true)}
            aria-label={`选择模型 ${row.name}`}
          />
        </div>
      </TableCell>
      <TableCell className="w-[56px] py-1.5 whitespace-nowrap">
        <div className="flex h-7 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Switch
                  size="sm"
                  checked={routeChecked}
                  disabled={upstreamInactive}
                  onCheckedChange={(checked) => onUpdate(row.id, { status: checked ? "active" : "disabled" })}
                  aria-label={`${row.name} 路由状态`}
                />
              </span>
            </TooltipTrigger>
            {upstreamInactive ? (
              <TooltipContent side="top" className="text-xs">
                渠道已停用
              </TooltipContent>
            ) : null}
          </Tooltip>
        </div>
      </TableCell>
      <TableCell className="max-w-[220px] py-1.5 font-mono text-xs text-muted-foreground">
        <span className="flex h-7 items-center truncate" title={row.upstreamModelId}>
          {row.upstreamModelId}
        </span>
      </TableCell>
      <TableCell className="min-w-[200px] py-1.5">
        <Input
          className="h-7 min-w-[200px] font-mono text-xs"
          value={row.nameDraft}
          aria-label="对话中显示的模型名"
          onChange={(event) => onUpdate(row.id, { nameDraft: event.target.value })}
        />
      </TableCell>
      <TableCell className="w-[200px] py-1.5 whitespace-nowrap">
        <UserProtocolDropdown
          value={row.protocol}
          onChange={(protocol) => onUpdate(row.id, { protocol })}
          className="h-7 px-2 py-0 text-[11px] has-[>svg]:px-2"
        />
      </TableCell>
      <TableCell className="w-[140px] py-1.5">
        <UserKindsDropdown
          value={row.kindsDisplay}
          onChange={(kindsDisplay) => onUpdate(row.id, { kindsDisplay })}
          className="h-7 px-2 py-0 text-[11px] has-[>svg]:px-2"
        />
      </TableCell>
      <TableCell className="w-[80px] py-1.5">
        <Input
          type="number"
          min={0}
          className="h-7 w-[70px] text-xs"
          value={row.priority}
          aria-label="优先级"
          onChange={(event) => onUpdate(row.id, { priority: Number(event.target.value) || 0 })}
        />
      </TableCell>
      <TableCell className="w-[80px] py-1.5">
        <Input
          type="number"
          min={0}
          className="h-7 w-[70px] text-xs"
          value={row.weight}
          aria-label="权重"
          onChange={(event) => onUpdate(row.id, { weight: Number(event.target.value) || 0 })}
        />
      </TableCell>
      <TableCell className="w-[48px] py-1.5 text-right" stickyEnd>
        <div className="flex h-7 items-center justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={testDisabled}
                  onClick={() => onTest(row)}
                  aria-label="测试模型"
                >
                  <Activity className="size-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {testDisabled ? "请先保存改动再测试" : "测试"}
            </TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  );
});

/** 用户自有渠道的模型路由管理对话框，功能对齐管理后台 */
export function UserModelsDialog({
  open,
  onOpenChange,
  upstream,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  upstream: UserUpstreamDTO | null;
  onChanged: () => void;
}) {
  const [rows, setRows] = React.useState<UserRowDraft[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);

  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("");
  const [protocolFilter, setProtocolFilter] = React.useState("");
  const [sortValue, setSortValue] = React.useState<SortValue>("upstream_asc");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(PAGE_SIZE_DEFAULT);

  const [bulkStatus, setBulkStatus] = React.useState<"active" | "disabled">("active");
  const [bulkProtocol, setBulkProtocol] = React.useState("openai_chat_completions");
  const [bulkKinds, setBulkKinds] = React.useState("chat");

  const [remoteOpen, setRemoteOpen] = React.useState(false);
  const [remoteLoading, setRemoteLoading] = React.useState(false);
  const [remoteModels, setRemoteModels] = React.useState<string[]>([]);
  const [remoteKeyword, setRemoteKeyword] = React.useState("");
  const [selectedRemote, setSelectedRemote] = React.useState<string[]>([]);
  const [importProtocol, setImportProtocol] = React.useState("openai_chat_completions");
  const [importing, setImporting] = React.useState(false);

  const upstreamID = upstream?.id ?? 0;
  const upstreamInactive = upstream?.status === "inactive";

  const loadModels = React.useCallback(async () => {
    if (!upstreamID) return;
    setLoading(true);
    try {
      const accessToken = await resolveAccessToken();
      const all = await listUserModels(accessToken);
      setRows(all.filter((item) => item.upstreamId === upstreamID).map(toRowDraft));
      setSelected(new Set());
    } catch (error) {
      toast.error(resolveErrorText(error, "加载模型失败"));
    } finally {
      setLoading(false);
    }
  }, [upstreamID]);

  React.useEffect(() => {
    if (open && upstreamID) {
      void loadModels();
      setImportProtocol(DEFAULT_PROTOCOL_BY_COMPATIBLE[upstream?.compatible ?? ""] ?? "openai_chat_completions");
    }
  }, [loadModels, open, upstream?.compatible, upstreamID]);

  const filteredRows = React.useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const result = rows.filter((row) => {
      if (keyword && !row.upstreamModelId.toLowerCase().includes(keyword) && !row.nameDraft.toLowerCase().includes(keyword)) {
        return false;
      }
      if (statusFilter && row.status !== statusFilter) return false;
      if (protocolFilter && row.protocol !== protocolFilter) return false;
      return true;
    });
    const compare: Record<SortValue, (a: UserRowDraft, b: UserRowDraft) => number> = {
      upstream_asc: (a, b) => a.upstreamModelId.localeCompare(b.upstreamModelId),
      upstream_desc: (a, b) => b.upstreamModelId.localeCompare(a.upstreamModelId),
      name_asc: (a, b) => a.nameDraft.localeCompare(b.nameDraft),
      name_desc: (a, b) => b.nameDraft.localeCompare(a.nameDraft),
      status_asc: (a, b) => a.status.localeCompare(b.status),
      protocol_asc: (a, b) => a.protocol.localeCompare(b.protocol),
    };
    return [...result].sort(compare[sortValue]);
  }, [protocolFilter, query, rows, sortValue, statusFilter]);

  const total = filteredRows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const visibleRows = React.useMemo(
    () => filteredRows.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize),
    [filteredRows, page, pageCount, pageSize],
  );
  const virtualRows = useVirtualTableRows(visibleRows, { enabled: visibleRows.length > 100, estimateSize: 40 });

  const allSelected = visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.id));
  const someSelected = visibleRows.some((row) => selected.has(row.id));
  const dirtyRows = React.useMemo(() => rows.filter((row) => row.isDirty), [rows]);

  const handleSelectOne = React.useCallback((id: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  function handleSelectAll(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of visibleRows) {
        if (checked) next.add(row.id);
        else next.delete(row.id);
      }
      return next;
    });
  }

  const updateRow = React.useCallback((id: number, patch: RowPatch) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch, isDirty: true } : row)));
  }, []);

  const handleTest = React.useCallback(async (row: UserRowDraft) => {
    try {
      const accessToken = await resolveAccessToken();
      const result = await testUserModel(accessToken, row.id);
      if (result.ok) {
        toast.success(`${row.name} 可用`, { description: `耗时 ${result.latencyMs} ms` });
      } else {
        toast.error(`${row.name} 不可用`, { description: result.message });
      }
    } catch (error) {
      toast.error(resolveErrorText(error, "测试失败"));
    }
  }, []);

  async function handleSave() {
    if (dirtyRows.length === 0) {
      toast.info("没有待保存的改动");
      return;
    }
    if (dirtyRows.some((row) => !row.nameDraft.trim())) {
      toast.error("模型名不能为空");
      return;
    }
    setSaving(true);
    try {
      const accessToken = await resolveAccessToken();
      for (const row of dirtyRows) {
        await updateUserModel(accessToken, row.id, {
          name: row.nameDraft.trim(),
          protocol: row.protocol,
          kinds: displayToKindsJson(row.kindsDisplay),
          status: row.status,
          priority: row.priority,
          weight: row.weight,
        });
      }
      toast.success(`已保存 ${dirtyRows.length} 项改动`);
      await loadModels();
      onChanged();
    } catch (error) {
      toast.error(resolveErrorText(error, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const accessToken = await resolveAccessToken();
      const result = await batchDeleteUserModels(accessToken, Array.from(selected));
      if (result.failedCount > 0) {
        toast.error(`删除完成，${result.successCount} 成功 / ${result.failedCount} 失败`);
      } else {
        toast.success(`已删除 ${result.successCount} 个模型`);
      }
      await loadModels();
      onChanged();
    } catch (error) {
      toast.error(resolveErrorText(error, "删除失败"));
    } finally {
      setDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }

  async function handleBulkApplyRemote(patch: RowPatch) {
    if (selected.size === 0) return;
    try {
      const accessToken = await resolveAccessToken();
      await batchUpdateUserModels(accessToken, Array.from(selected), {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.protocol ? { protocol: patch.protocol } : {}),
        ...(patch.kindsDisplay ? { kinds: displayToKindsJson(patch.kindsDisplay) } : {}),
      });
      toast.success(`已应用到 ${selected.size} 个模型`);
      await loadModels();
      onChanged();
    } catch (error) {
      toast.error(resolveErrorText(error, "批量应用失败"));
    }
  }

  async function openRemoteDialog() {
    if (!upstreamID) return;
    setRemoteOpen(true);
    setSelectedRemote([]);
    setRemoteKeyword("");
    setRemoteLoading(true);
    try {
      const accessToken = await resolveAccessToken();
      setRemoteModels(await listUserRemoteModels(accessToken, upstreamID));
    } catch (error) {
      toast.error(resolveErrorText(error, "获取远端模型失败"));
    } finally {
      setRemoteLoading(false);
    }
  }

  async function handleImport() {
    if (!upstreamID || selectedRemote.length === 0) return;
    setImporting(true);
    try {
      const accessToken = await resolveAccessToken();
      const kinds = JSON.stringify([
        ...(PROTOCOL_PRESETS.find((item) => item.value === importProtocol)?.kinds ?? ["chat"]),
      ]);
      const payloads = selectedRemote.map((name) => ({
        upstreamModelId: name,
        name: name.slice(0, 128),
        protocol: importProtocol,
        kinds,
        priority: 1,
        weight: 1,
      }));
      if (payloads.length === 1) {
        await createUserModel(accessToken, upstreamID, payloads[0]);
        toast.success("已导入 1 个模型");
      } else {
        const result = await batchCreateUserModels(accessToken, upstreamID, payloads);
        if (result.failedCount > 0) {
          toast.warning(`导入 ${result.successCount} 个成功，${result.failedCount} 个失败：${result.failed.join("、")}`);
        } else {
          toast.success(`已导入 ${result.successCount} 个模型`);
        }
      }
      setRemoteOpen(false);
      await loadModels();
      onChanged();
    } catch (error) {
      if (isDuplicateModelError(error)) {
        toast.info("该模型已经同步，无需重复添加");
        setRemoteOpen(false);
        await loadModels();
        onChanged();
      } else {
        toast.error(resolveErrorText(error, "导入失败"));
      }
    } finally {
      setImporting(false);
    }
  }

  const importedIDs = React.useMemo(() => new Set(rows.map((row) => row.upstreamModelId)), [rows]);
  const filteredRemote = React.useMemo(() => {
    const keyword = remoteKeyword.trim().toLowerCase();
    if (!keyword) return remoteModels;
    return remoteModels.filter((name) => name.toLowerCase().includes(keyword));
  }, [remoteKeyword, remoteModels]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[min(86vh,760px)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px] md:w-[calc(100vw-8rem)]">
          <DialogHeader className="shrink-0 px-4 py-4">
            <DialogTitle>管理模型路由</DialogTitle>
            <DialogDescription>管理该渠道下已配置的模型路由，需要新增模型请通过同步导入。</DialogDescription>
          </DialogHeader>

          <div className="shrink-0 px-4 pb-3">
            <TableToolbar
              query={query}
              onQueryChange={(value) => {
                setQuery(value);
                setPage(1);
              }}
              queryPlaceholder="搜索上游模型名或显示名"
              loading={loading}
              selectedCount={selected.size}
              onRefresh={() => void loadModels()}
              refreshLoading={loading}
              refreshDisabled={loading || !upstreamID}
              refreshLabel="刷新模型"
              filters={[
                {
                  key: "status",
                  label: "路由状态",
                  value: statusFilter,
                  onValueChange: (value) => {
                    setStatusFilter(value as StatusFilter);
                    setPage(1);
                  },
                  options: [
                    { label: "全部状态", value: "" },
                    { label: "启用", value: "active" },
                    { label: "停用", value: "disabled" },
                  ],
                },
                {
                  key: "protocol",
                  label: "接口协议",
                  value: protocolFilter,
                  onValueChange: (value) => {
                    setProtocolFilter(value);
                    setPage(1);
                  },
                  options: [
                    { label: "全部协议", value: "" },
                    ...PROTOCOL_PRESETS.map((item) => ({ label: item.label, value: item.value })),
                  ],
                },
              ]}
              sort={{
                value: sortValue,
                onValueChange: (value) => setSortValue(value as SortValue),
                options: [
                  { label: "上游模型名升序", value: "upstream_asc" },
                  { label: "上游模型名降序", value: "upstream_desc" },
                  { label: "显示名升序", value: "name_asc" },
                  { label: "显示名降序", value: "name_desc" },
                  { label: "按状态", value: "status_asc" },
                  { label: "按协议", value: "protocol_asc" },
                ],
              }}
              bulkContent={
                <div className="space-y-1">
                  <div className="flex h-7 w-full items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 w-16 shrink-0 justify-start gap-2 px-2 text-[11px]"
                      disabled={selected.size === 0}
                      onClick={() => void handleBulkApplyRemote({ status: bulkStatus })}
                    >
                      <ToggleLeft className="size-3 stroke-1" />
                      应用
                    </Button>
                    <div className="min-w-0 flex-1">
                      <Select value={bulkStatus} onValueChange={(value) => setBulkStatus(value as "active" | "disabled")}>
                        <SelectTrigger size="xs" className="h-7 px-2 text-[11px] text-muted-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" align="start" className="z-[100]">
                          <SelectItem value="active" className="text-[11px]">启用</SelectItem>
                          <SelectItem value="disabled" className="text-[11px]">停用</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="flex h-7 w-full items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 w-16 shrink-0 justify-start gap-2 px-2 text-[11px]"
                      disabled={selected.size === 0}
                      onClick={() => void handleBulkApplyRemote({ protocol: bulkProtocol })}
                    >
                      <Cable className="size-3 stroke-1" />
                      应用
                    </Button>
                    <div className="min-w-0 flex-1">
                      <UserProtocolDropdown
                        value={bulkProtocol}
                        onChange={setBulkProtocol}
                        disabled={selected.size === 0}
                        className="h-7 w-full px-2 text-[11px]"
                      />
                    </div>
                  </div>

                  <div className="flex h-7 w-full items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 w-16 shrink-0 justify-start gap-2 px-2 text-[11px]"
                      disabled={selected.size === 0 || !bulkKinds}
                      onClick={() => void handleBulkApplyRemote({ kindsDisplay: bulkKinds })}
                    >
                      <Tags className="size-3 stroke-1" />
                      应用
                    </Button>
                    <div className="min-w-0 flex-1">
                      <UserKindsDropdown
                        value={bulkKinds}
                        onChange={setBulkKinds}
                        disabled={selected.size === 0}
                        className="h-7 w-full px-2 text-[11px]"
                      />
                    </div>
                  </div>
                </div>
              }
              bulkActions={[
                {
                  key: "delete-models",
                  label: "删除模型",
                  icon: <Trash2 />,
                  onClick: () => setDeleteConfirmOpen(true),
                  disabled: deleting,
                },
              ]}
            >
              <Button size="sm" onClick={() => void openRemoteDialog()} disabled={!upstreamID}>
                <CloudDownload className="size-3" />
                同步
              </Button>
            </TableToolbar>
          </div>

          <div className="min-h-0 overflow-hidden px-4 py-2">
            <Table
              className="min-w-[860px]"
              shellClassName="min-h-0"
              viewportRef={virtualRows.viewportRef}
              viewportClassName={cn(virtualRows.viewportClassName, "overscroll-contain")}
              viewportStyle={{ ...virtualRows.viewportStyle, maxHeight: "min(480px, calc(86vh - 260px))" }}
            >
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[44px] py-1.5 text-center">
                    <div className="flex h-7 items-center justify-center">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => handleSelectAll(checked === true)}
                        aria-label="全选"
                      />
                    </div>
                  </TableHead>
                  <TableHead className="w-[56px]">状态</TableHead>
                  <TableHead>上游模型名</TableHead>
                  <TableHead className="min-w-[200px]">显示名</TableHead>
                  <TableHead className="w-[200px]">接口协议</TableHead>
                  <TableHead className="w-[140px]">能力</TableHead>
                  <TableHead className="w-[80px]">优先级</TableHead>
                  <TableHead className="w-[80px]">权重</TableHead>
                  <TableHead className="w-[48px]" stickyEnd />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && rows.length === 0 ? <TableLoadingRow colSpan={9} /> : null}
                {!loading && visibleRows.length === 0 ? (
                  <TableEmptyRow colSpan={9}>
                    {rows.length === 0 ? "还没有配置任何模型，点击同步导入" : "没有匹配的模型"}
                  </TableEmptyRow>
                ) : null}
                {visibleRows.length > 0 ? <VirtualTablePaddingRow colSpan={9} height={virtualRows.paddingTop} /> : null}
                {virtualRows.rows.map(({ item: row }) => (
                  <ModelRow
                    key={row.id}
                    row={row}
                    isSelected={selected.has(row.id)}
                    upstreamInactive={upstreamInactive}
                    onSelect={handleSelectOne}
                    onUpdate={updateRow}
                    onTest={(target) => void handleTest(target)}
                  />
                ))}
                {visibleRows.length > 0 ? <VirtualTablePaddingRow colSpan={9} height={virtualRows.paddingBottom} /> : null}
              </TableBody>
            </Table>
          </div>

          <TablePagination
            total={total}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(next) => {
              setPageSize(next);
              setPage(1);
            }}
            loading={loading}
            className="shrink-0 px-4 py-3"
          />

          <DialogFooter className="shrink-0 px-4 py-3">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              关闭
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || dirtyRows.length === 0}>
              {saving ? <SpinnerLabel>保存中</SpinnerLabel> : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={remoteOpen} onOpenChange={setRemoteOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>同步远端模型</DialogTitle>
            <DialogDescription>从接口模型列表中批量选择并导入为你的私有模型路由</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <UserProtocolDropdown value={importProtocol} onChange={setImportProtocol} />

            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="搜索模型"
                value={remoteKeyword}
                onChange={(event) => setRemoteKeyword(event.target.value)}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>已选 {selectedRemote.length} / 可选 {filteredRemote.filter((name) => !importedIDs.has(name)).length}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={remoteLoading}
                onClick={() => {
                  const selectable = filteredRemote.filter((name) => !importedIDs.has(name));
                  setSelectedRemote((prev) => (prev.length === selectable.length ? [] : selectable));
                }}
              >
                全选 / 取消
              </Button>
            </div>

            {remoteLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                <SpinnerLabel>正在获取模型列表</SpinnerLabel>
              </div>
            ) : filteredRemote.length === 0 ? (
              <div className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                没有可用的远端模型
              </div>
            ) : (
              <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
                {filteredRemote.map((name) => {
                  const imported = importedIDs.has(name);
                  return (
                    <label
                      key={name}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
                        imported ? "text-muted-foreground" : "cursor-pointer hover:bg-muted",
                      )}
                    >
                      <Checkbox
                        checked={selectedRemote.includes(name)}
                        disabled={imported}
                        onCheckedChange={(next) =>
                          setSelectedRemote((prev) =>
                            next === true ? [...prev, name] : prev.filter((item) => item !== name),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
                      {imported ? <span className="shrink-0 text-xs">已导入</span> : null}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoteOpen(false)}>
              取消
            </Button>
            <Button disabled={importing || remoteLoading || selectedRemote.length === 0} onClick={() => void handleImport()}>
              {importing ? <SpinnerLabel>导入中</SpinnerLabel> : `导入 ${selectedRemote.length} 个模型`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={(next) => !deleting && setDeleteConfirmOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量删除模型</AlertDialogTitle>
            <AlertDialogDescription>
              将删除选中的 {selected.size} 个模型路由，删除后使用这些模型的对话将无法继续。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting || selected.size === 0}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteSelected();
              }}
            >
              {deleting ? <SpinnerLabel>删除中</SpinnerLabel> : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
