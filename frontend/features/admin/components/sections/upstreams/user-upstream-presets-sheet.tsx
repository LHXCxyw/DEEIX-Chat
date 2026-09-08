"use client";

import {
  ArrowDown,
  ArrowUp,
  Pencil,
  Plus,
  Save,
  Settings2,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  listAdminUserUpstreamPresets,
  replaceAdminUserUpstreamPresets,
} from "@/features/admin/api";
import type {
  AdminLLMCompatible,
  AdminUserUpstreamPreset,
} from "@/features/admin/api/llm.types";
import { COMPATIBLE_OPTIONS } from "@/features/admin/utils/llm-display";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

const EMPTY_DEFAULTS = "{}";

type PresetForm = Omit<AdminUserUpstreamPreset, "sort_order">;
type ConfirmAction =
  | { type: "disable"; preset: AdminUserUpstreamPreset }
  | { type: "delete"; preset: AdminUserUpstreamPreset }
  | null;

function createPresetID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `preset-${Date.now().toString(36)}`;
}

function emptyForm(): PresetForm {
  return {
    id: createPresetID(),
    name: "",
    base_url: "",
    compatible: "openai",
    protocol_defaults: EMPTY_DEFAULTS,
    enabled: true,
  };
}

function normalizeDefaults(raw: string): string {
  const parsed: unknown = JSON.parse(raw.trim() || EMPTY_DEFAULTS);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("protocol_defaults must be a JSON object");
  }
  return JSON.stringify(parsed);
}

function validateHTTPURL(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function UserUpstreamPresetsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("adminUpstreams.presets");
  const commonT = useTranslations("common.actions");
  const [items, setItems] = React.useState<AdminUserUpstreamPreset[]>([]);
  const [form, setForm] = React.useState<PresetForm | null>(null);
  const [editingID, setEditingID] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [confirmAction, setConfirmAction] = React.useState<ConfirmAction>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const token = await resolveAccessToken();
      const presets = await listAdminUserUpstreamPresets(token);
      const sorted = [...presets].sort((a, b) => a.sort_order - b.sort_order);
      setItems(sorted);
      setForm(sorted[0] ? { ...sorted[0] } : null);
      setEditingID(sorted[0]?.id ?? null);
      setDirty(false);
    } catch (error) {
      toast.error(t("loadFailed"), { description: errorMessage(error, t("unknownError")) });
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    if (open) void load();
  }, [load, open]);

  function selectPreset(item: AdminUserUpstreamPreset) {
    setForm({ ...item });
    setEditingID(item.id);
  }

  function updateForm<K extends keyof PresetForm>(key: K, value: PresetForm[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function applyForm() {
    if (!form) return;
    const id = form.id.trim();
    const name = form.name.trim();
    const baseURL = form.base_url.trim();
    if (!id || !name || !baseURL) {
      toast.error(t("required"));
      return;
    }
    if (!validateHTTPURL(baseURL)) {
      toast.error(t("invalidUrl"));
      return;
    }
    if (items.some((item) => item.id === id && item.id !== editingID)) {
      toast.error(t("duplicateId"));
      return;
    }
    let protocolDefaults: string;
    try {
      protocolDefaults = normalizeDefaults(form.protocol_defaults);
    } catch {
      toast.error(t("invalidDefaults"));
      return;
    }

    const existingIndex = editingID === null ? -1 : items.findIndex((item) => item.id === editingID);
    const nextItem: AdminUserUpstreamPreset = {
      ...form,
      id,
      name,
      base_url: baseURL,
      protocol_defaults: protocolDefaults,
      sort_order: existingIndex >= 0 ? items[existingIndex].sort_order : items.length,
    };
    setItems((current) =>
      existingIndex >= 0
        ? current.map((item) => (item.id === editingID ? nextItem : item))
        : [...current, nextItem],
    );
    setForm({ ...nextItem });
    setEditingID(nextItem.id);
    setDirty(true);
    toast.success(existingIndex >= 0 ? t("updatedDraft") : t("addedDraft"));
  }

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    setItems((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  }

  function requestToggle(item: AdminUserUpstreamPreset, enabled: boolean) {
    if (!enabled) {
      setConfirmAction({ type: "disable", preset: item });
      return;
    }
    setItems((current) =>
      current.map((entry) => (entry.id === item.id ? { ...entry, enabled: true } : entry)),
    );
    if (editingID === item.id) setForm((current) => (current ? { ...current, enabled: true } : current));
    setDirty(true);
  }

  function confirmPendingAction() {
    if (!confirmAction) return;
    if (confirmAction.type === "delete") {
      setItems((current) =>
        current.map((item) =>
          item.id === confirmAction.preset.id ? { ...item, enabled: false } : item,
        ),
      );
      if (editingID === confirmAction.preset.id) {
        setForm((current) => (current ? { ...current, enabled: false } : current));
      }
    } else {
      setItems((current) =>
        current.map((item) =>
          item.id === confirmAction.preset.id ? { ...item, enabled: false } : item,
        ),
      );
      if (editingID === confirmAction.preset.id) {
        setForm((current) => (current ? { ...current, enabled: false } : current));
      }
    }
    setDirty(true);
    setConfirmAction(null);
  }

  async function saveAll() {
    if (saving || loading) return;
    setSaving(true);
    try {
      const payload = items.map((item, index) => ({ ...item, sort_order: index }));
      const token = await resolveAccessToken();
      await replaceAdminUserUpstreamPresets(token, payload);
      setItems(payload);
      setDirty(false);
      toast.success(t("saveSuccess"));
      onOpenChange(false);
    } catch (error) {
      toast.error(t("saveFailed"), { description: errorMessage(error, t("unknownError")) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!saving) onOpenChange(next);
        }}
      >
        <SheetContent className="gap-0 sm:max-w-[840px]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-sm">
              <Settings2 className="size-4" />
              {t("title")}
            </SheetTitle>
            <SheetDescription className="text-xs">{t("description")}</SheetDescription>
          </SheetHeader>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto px-6 pb-4 md:grid-cols-[minmax(280px,0.9fr)_minmax(320px,1.1fr)] md:overflow-hidden">
            <section className="flex min-h-[280px] flex-col overflow-hidden rounded-lg border">
              <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
                <span className="text-xs font-medium">{t("listTitle", { count: items.length })}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    setForm(emptyForm());
                    setEditingID(null);
                  }}
                >
                  <Plus className="size-3.5" />
                  {t("add")}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {loading ? (
                  <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground">
                    <Spinner className="mr-2 size-4" />
                    {t("loading")}
                  </div>
                ) : items.length === 0 ? (
                  <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground">
                    {t("empty")}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {items.map((item, index) => (
                      <div
                        key={item.id}
                        className={`flex items-center gap-1 rounded-md border px-2 py-2 ${form?.id === item.id ? "border-primary/40 bg-accent" : "border-transparent hover:bg-accent/60"}`}
                      >
                        <Switch
                          size="sm"
                          checked={item.enabled}
                          onCheckedChange={(checked) => requestToggle(item, checked)}
                          aria-label={t("toggle", { name: item.name })}
                        />
                        <button type="button" className="min-w-0 flex-1 px-1 text-left" onClick={() => selectPreset(item)}>
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-medium">{item.name}</span>
                            {!item.enabled ? <Badge variant="secondary" className="px-1 text-[10px]">{t("disabled")}</Badge> : null}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">{item.base_url}</span>
                        </button>
                        <Button type="button" size="icon" variant="ghost" className="size-7" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("moveUp")}>
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" className="size-7" disabled={index === items.length - 1} onClick={() => move(index, 1)} aria-label={t("moveDown")}>
                          <ArrowDown className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" className="size-7" onClick={() => selectPreset(item)} aria-label={t("edit")}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" className="size-7 text-destructive" onClick={() => setConfirmAction({ type: "delete", preset: item })} aria-label={t("delete")}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="min-h-[360px] overflow-y-auto rounded-lg border p-4">
              {form ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold">{items.some((item) => item.id === form.id) ? t("editTitle") : t("createTitle")}</h3>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="preset-enabled" className="text-xs">{t("enabled")}</Label>
                      <Switch id="preset-enabled" size="sm" checked={form.enabled} onCheckedChange={(checked) => updateForm("enabled", checked)} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="preset-id">{t("id")}</Label>
                    <Input id="preset-id" maxLength={64} value={form.id} disabled={items.some((item) => item.id === form.id)} onChange={(event) => updateForm("id", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="preset-name">{t("name")}</Label>
                    <Input id="preset-name" maxLength={128} value={form.name} onChange={(event) => updateForm("name", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="preset-url">{t("baseUrl")}</Label>
                    <Input id="preset-url" maxLength={512} placeholder="https://api.example.com/v1" value={form.base_url} onChange={(event) => updateForm("base_url", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("compatible")}</Label>
                    <Select value={form.compatible} onValueChange={(value) => updateForm("compatible", value as AdminLLMCompatible)}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {COMPATIBLE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="preset-defaults">{t("protocolDefaults")}</Label>
                    <Textarea id="preset-defaults" className="min-h-28 font-mono text-xs" maxLength={20000} placeholder="{}" value={form.protocol_defaults} onChange={(event) => updateForm("protocol_defaults", event.target.value)} />
                    <p className="text-[11px] text-muted-foreground">{t("protocolDefaultsHint")}</p>
                  </div>
                  <Button type="button" size="sm" className="w-full gap-1.5" onClick={applyForm}>
                    <Save className="size-3.5" />
                    {t("applyDraft")}
                  </Button>
                </div>
              ) : (
                <div className="flex h-full min-h-72 items-center justify-center text-center text-xs text-muted-foreground">{t("selectHint")}</div>
              )}
            </section>
          </div>

          <SheetFooter className="flex-row items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>{commonT("cancel")}</Button>
            <Button type="button" size="sm" onClick={() => void saveAll()} disabled={!dirty || saving || loading}>
              {saving ? commonT("saving") : t("saveAll")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmAction !== null} onOpenChange={(next) => !next && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.type === "delete" ? t("deleteTitle") : t("disableTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === "delete"
                ? t("deleteDescription", { name: confirmAction.preset.name })
                : t("disableDescription", { name: confirmAction?.preset.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{commonT("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant={confirmAction?.type === "delete" ? "destructive" : "default"} onClick={confirmPendingAction}>
              {commonT("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
