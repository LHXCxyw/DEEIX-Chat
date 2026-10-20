"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ConversationOptions } from "@/shared/api/conversation-types";
import { JsonCodeEditor } from "@/shared/components/json-code-editor";
import { isRecord, parseJSON } from "@/shared/lib/type-guards";

// 画布节点的高级参数配置：与对话侧「高级参数配置」一致，直接编辑节点 options 的原始 JSON。
// 用于写入没有可视化控件的透传参数（如 generate_audio / watermark），以及管理员声明的自定义键。
export function CanvasCustomParamsDialog({
  open,
  onOpenChange,
  options,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: ConversationOptions;
  onSave: (options: ConversationOptions) => void;
}) {
  const t = useTranslations("canvas");
  const tActions = useTranslations("common.actions");
  const [draft, setDraft] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);

  // 每次打开都以当前节点参数重新起草，避免上一次未保存的编辑残留
  React.useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(JSON.stringify(options, null, 2));
    setInvalid(false);
  }, [open, options]);

  const handleSave = () => {
    const parsed = parseJSON(draft);
    if (!isRecord(parsed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSave(parsed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-canvas-ui="custom-params" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("imageParamsAdvanced")}</DialogTitle>
        </DialogHeader>
        <JsonCodeEditor value={draft} height={320} autoFocus onChange={setDraft} />
        {invalid ? <p className="text-xs text-destructive">{t("imageParamsInvalidJson")}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {tActions("cancel")}
          </Button>
          <Button type="button" onClick={handleSave}>
            {tActions("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
