"use client";

import { RefreshCw, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAdminToolsCommandSlots } from "@/features/admin/hooks/use-admin-tools-command-slots";
import { SettingsSection } from "@/shared/components/settings-layout";

export function ToolsCommandSlots() {
  const t = useTranslations("adminTools.commandSlots");
  const locale = useLocale();
  const state = useAdminToolsCommandSlots();
  const formatLease = (value?: string) => {
    if (!value) return t("noLease");
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t("noLease");
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date);
  };

  return (
    <SettingsSection
      title={t("title")}
      actions={
        <Button variant="outline" size="sm" disabled={state.loading || state.recovering} onClick={() => void state.refresh()}>
          {state.loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          {t("refresh")}
        </Button>
      }
    >
      <p className="text-xs leading-relaxed text-muted-foreground">{t("description")}</p>
      <div aria-live="polite" className="space-y-3">
        {state.notice ? (
          <p role={state.notice.success ? "status" : "alert"} className={state.notice.success ? "text-sm text-muted-foreground" : "break-words text-sm text-destructive"}>
            {state.notice.message}
          </p>
        ) : null}
        {state.loadError ? <p role="alert" className="break-words text-sm text-destructive">{t("loadFailed")} {state.loadError}</p> : null}
        {state.loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />{t("loading")}</p> : null}
        {!state.loading && !state.loadError && state.slots.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{t("empty")}</p> : null}
        {state.slots.map((slot) => (
          <div key={slot.slot} className="space-y-3 rounded-lg border border-border/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium">{t("slot", { slot: slot.slot })}</h4>
                <Badge variant="outline">{slot.recovery === "available" ? t("available") : t("blocked")}</Badge>
              </div>
              <Button variant="outline" size="sm" disabled={state.loading || Boolean(state.loadError) || state.recovering || slot.recovery !== "available"} onClick={() => state.select(slot)}>
                <RotateCcw className="size-3.5" />{t("recover")}
              </Button>
            </div>
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              {[
                [t("owner"), String(slot.owner_user_id)],
                [t("operation"), slot.operation_id],
                [t("status"), slot.operation_status || t("unknown")],
                [t("revision"), String(slot.operation_revision)],
                [t("lease"), formatLease(slot.lease_until)],
                [t("operationLease"), formatLease(slot.operation_lease_until)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 space-y-1">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all font-mono">{value}</dd>
                </div>
              ))}
            </dl>
            {slot.blocked_reason || slot.recovery !== "available" ? (
              <p className="break-words text-xs text-muted-foreground">{t("reason")}: <span className="font-mono">{slot.blocked_reason || t("unknownReason")}</span></p>
            ) : null}
          </div>
        ))}
      </div>
      <AlertDialog open={state.selected !== null} onOpenChange={(open) => { if (!open) state.select(null); }}>
        <AlertDialogContent size="compact">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          {state.selected ? (
            <dl className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
              <div>{t("slot", { slot: state.selected.slot })} · {t("owner")}: {state.selected.owner_user_id}</div>
              <div className="break-all">{t("operation")}: {state.selected.operation_id}</div>
              <div>{t("revision")}: {state.selected.operation_revision}</div>
            </dl>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={state.recovering}>{t("cancel")}</AlertDialogCancel>
            <Button disabled={state.recovering} onClick={() => void state.recover()}>
              {state.recovering ? <Spinner className="size-4" /> : <RotateCcw className="size-4" />}{t("confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
