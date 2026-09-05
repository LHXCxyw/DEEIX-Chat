"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner, SpinnerLabel } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

const SYSTEM_PROMPT_MAX_CHARS = 12000;

/**
 * 会话系统提示词编辑对话框：既用于会话标题菜单（已有会话），
 * 也用于输入框工具栏（首次对话尚无会话时）。
 */
export function ConversationSystemPromptDialog({
  open,
  onOpenChange,
  systemPrompt,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  systemPrompt: string;
  onSave: (systemPrompt: string) => void | Promise<void>;
}) {
  const t = useTranslations("chat.labelMenu");
  const common = useTranslations("common.actions");
  const [value, setValue] = React.useState(systemPrompt);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setValue(systemPrompt);
    }
  }, [open, systemPrompt]);

  const commit = React.useCallback(async () => {
    if (saving) {
      onOpenChange(false);
      return;
    }
    const nextValue = value.trim();
    if (nextValue === systemPrompt.trim()) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(nextValue);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }, [onOpenChange, onSave, saving, systemPrompt, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("systemPrompt")}</DialogTitle>
          <DialogDescription>{t("systemPromptDescription")}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void commit();
          }}
          className="space-y-4"
        >
          <Textarea
            autoFocus
            value={value}
            className="min-h-[180px] resize-none text-sm leading-6"
            onChange={(event) => setValue(event.target.value)}
            placeholder={t("systemPromptPlaceholder")}
            maxLength={SYSTEM_PROMPT_MAX_CHARS}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              {common("cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <SpinnerLabel>{common("saving")}</SpinnerLabel> : common("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
