"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChatAreaMessage } from "@/features/chat/types/messages";
import { useLocalizedErrorMessage } from "@/i18n/use-localized-error";
import {
  previewConversationRewind,
  rewindConversationToMessage,
} from "@/shared/api/conversation";
import type { ConversationRewindPreviewItemDTO } from "@/shared/api/conversation.types";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

function actionLabelKey(action: string): "rewindActionRestore" | "rewindActionCreate" | "rewindActionDelete" {
  switch (action) {
    case "create":
      return "rewindActionCreate";
    case "delete":
      return "rewindActionDelete";
    default:
      return "rewindActionRestore";
  }
}

export function ChatRewindDialog({
  message,
  conversationID,
  onClose,
  onRewound,
}: {
  message: ChatAreaMessage | null;
  conversationID: string;
  onClose: () => void;
  onRewound: (tipPublicID: string) => void;
}) {
  const t = useTranslations("chat.messages");
  const tCommon = useTranslations("common.actions");
  const resolveErrorMessage = useLocalizedErrorMessage();
  const [items, setItems] = React.useState<ConversationRewindPreviewItemDTO[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const messagePublicID = message?.publicID?.trim() || "";

  React.useEffect(() => {
    if (!messagePublicID || !conversationID) {
      setItems(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const token = await resolveAccessToken();
        if (!token) {
          throw new Error(t("authTokenMissing"));
        }
        const preview = await previewConversationRewind(token, conversationID, messagePublicID);
        if (!cancelled) {
          setItems(preview.items ?? []);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(t("rewindFailed"), { description: resolveErrorMessage(error) });
          onClose();
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationID, messagePublicID, onClose, resolveErrorMessage, t]);

  const handleConfirm = React.useCallback(async () => {
    if (!messagePublicID || !conversationID) {
      return;
    }
    setSubmitting(true);
    try {
      const token = await resolveAccessToken();
      if (!token) {
        throw new Error(t("authTokenMissing"));
      }
      const result = await rewindConversationToMessage(token, conversationID, messagePublicID);
      toast.success(t("rewindSuccess"));
      onRewound(result.activeTipMessagePublicID || messagePublicID);
    } catch (error) {
      toast.error(t("rewindFailed"), { description: resolveErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  }, [conversationID, messagePublicID, onRewound, resolveErrorMessage, t]);

  const affected = items ?? [];

  return (
    <Dialog open={Boolean(message)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("rewindTitle")}</DialogTitle>
          <DialogDescription>{t("rewindDescription")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">…</div>
        ) : affected.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t("rewindNoChanges")}</p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t("rewindAffectedFiles")} · {affected.length}
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/70 bg-muted/20 p-2">
              {affected.map((item) => (
                <div key={`${item.relativePath}-${item.action}`} className="flex items-center gap-2 text-xs">
                  <span className="w-10 shrink-0 rounded bg-muted/60 px-1 py-0.5 text-center text-[10px] text-muted-foreground">
                    {t(actionLabelKey(item.action))}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={item.relativePath}>{item.relativePath}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={loading || submitting}
            onClick={() => void handleConfirm()}
          >
            {submitting ? "…" : t("rewindConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
