"use client";

import { Globe, RotateCw, ShieldQuestion, Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useChatToolApprovals } from "@/features/chat/hooks/use-chat-tool-approvals";
import { useAgentCapabilities } from "@/shared/hooks/use-agent-capabilities";

function AgentCapabilityNotice() {
  const t = useTranslations("chat.toolApprovals");
  const { data, failed, loading, refresh } = useAgentCapabilities();
  return (
    <aside aria-label={t("capabilities")} className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><Globe className="size-3.5" />{!data ? t("browserProjectUnknown") : data.project_browser.ready ? t("browserProjectReady") : t("browserProjectUnavailable")}</span>
      <span className="flex items-center gap-1.5"><Globe className="size-3.5" />{!data ? t("browserPublicUnknown") : data.browser.ready ? t("browserPublicReady") : t("browserPublicUnavailable")}</span>
      <span className="flex items-center gap-1.5"><Terminal className="size-3.5" />{!data ? t("commandUnknown") : data.command.ready ? t("commandReady") : t("commandUnavailable")}</span>
      {failed ? <><span role="status">{t("capabilitiesFailed")}</span><button type="button" className="inline-flex items-center gap-1 underline underline-offset-2" onClick={refresh}><RotateCw className="size-3" />{t("retry")}</button></> : loading ? <span role="status">{t("capabilitiesLoading")}</span> : null}
    </aside>
  );
}

function readableArguments(value: string) {
  if (value.length > 12000) return `${value.slice(0, 12000)}\n…`;
  try {
    const formatted = JSON.stringify(JSON.parse(value), null, 2);
    return formatted.length > 12000 ? `${formatted.slice(0, 12000)}\n…` : formatted;
  } catch {
    return value;
  }
}

export function ChatToolApprovals({ conversationID }: { conversationID?: string }) {
  const t = useTranslations("chat.toolApprovals");
  const { items, busy, failed, decide } = useChatToolApprovals(conversationID);
  return (
    <>
    <AgentCapabilityNotice />
    {items.length || failed ? <section aria-label={t("title")} className="mb-3 max-h-80 space-y-2 overflow-y-auto rounded-xl border bg-background p-3">
      <h3 className="flex items-center gap-2 text-sm font-medium"><ShieldQuestion className="size-4 text-amber-600" />{t("title")}</h3>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      <p className="text-xs text-muted-foreground">{t("argumentsBoundary")}</p>
      {failed ? <p role="alert" className="text-xs text-destructive">{t("loadFailed")}</p> : null}
      {items.map((item) => (
        <div key={item.id} className="space-y-2 rounded-lg border p-3">
          <p className="break-all text-sm font-medium">{item.tool_name.slice(0, 160)}</p>
          <p className="break-all text-xs text-muted-foreground">{t("run", { id: item.run_id.slice(0, 80) })}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 text-xs">{readableArguments(item.arguments_json)}</pre>
          <p className="text-xs text-muted-foreground">{t("expires", { time: new Date(item.expires_at).toLocaleTimeString() })}</p>
          <div className="flex justify-end gap-2">
            {(["deny", "allow"] as const).map((decision) => (
              <Button key={decision} type="button" size="sm" variant={decision === "deny" ? "outline" : "default"} disabled={Boolean(busy) || failed || Date.parse(item.expires_at) <= Date.now()} onClick={() => { void decide(item, decision).catch(() => toast.error(t("decisionFailed"))); }}>{busy === item.id ? t("submitting") : t(decision)}</Button>
            ))}
          </div>
        </div>
      ))}
    </section> : null}
    </>
  );
}
