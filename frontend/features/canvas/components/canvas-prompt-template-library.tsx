"use client";

import { BookmarkPlus, Check, LibraryBig, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  createUserPromptTemplate,
  loadPromptTemplates,
  type PromptTemplate,
  saveUserPromptTemplates,
} from "@/features/canvas/model/canvas-graph";
import { cn } from "@/lib/utils";

// 提示词模板库：内置模板 + 用户自建模板（localStorage 持久化），点击应用到节点
export function PromptTemplateLibrary({
  promptText,
  onApply,
}: {
  promptText: string;
  onApply: (text: string) => void;
}) {
  const t = useTranslations("canvas");
  const [open, setOpen] = React.useState(false);
  const [templates, setTemplates] = React.useState<PromptTemplate[]>([]);
  const [saveName, setSaveName] = React.useState("");
  const [savedID, setSavedID] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setTemplates(loadPromptTemplates());
      setSavedID(null);
    }
  }, [open]);

  const persistUserTemplates = React.useCallback((next: PromptTemplate[]) => {
    setTemplates(next);
    saveUserPromptTemplates(next);
  }, []);

  const handleSave = React.useCallback(() => {
    if (!promptText.trim()) {
      return;
    }
    const template = createUserPromptTemplate(saveName, promptText);
    persistUserTemplates([template, ...templates]);
    setSaveName("");
    setSavedID(template.id);
  }, [persistUserTemplates, promptText, saveName, templates]);

  const handleDelete = React.useCallback(
    (id: string) => {
      persistUserTemplates(templates.filter((item) => item.id !== id));
    },
    [persistUserTemplates, templates],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-canvas-selectable
        title={t("templateLibrary")}
        className="pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2 text-[11px] font-medium text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <LibraryBig className="size-3.5" strokeWidth={1.8} />
        {t("templateLibrary")}
      </PopoverTrigger>
      <PopoverContent
        data-canvas-ui="prompt-template-library"
        align="start"
        side="top"
        sideOffset={8}
        className="w-80 p-2"
      >
        <p className="px-1 pb-1.5 text-xs font-medium text-foreground/80">{t("templateLibrary")}</p>
        <div className="max-h-64 space-y-1 overflow-y-auto overscroll-contain pr-0.5">
          {templates.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t("templateLibraryEmpty")}</p>
          ) : (
            templates.map((template) => (
              <div
                key={template.id}
                className="group/tpl flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/60"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left outline-none"
                  onClick={() => {
                    onApply(template.text);
                    setOpen(false);
                  }}
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    {template.name}
                    {template.createdAt === 0 ? (
                      <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-semibold text-muted-foreground">
                        {t("templateBuiltin")}
                      </span>
                    ) : null}
                    {savedID === template.id ? (
                      <Check className="size-3 text-primary" strokeWidth={2} />
                    ) : null}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                    {template.text}
                  </span>
                </button>
                {template.createdAt !== 0 ? (
                  <button
                    type="button"
                    aria-label={t("templateDelete")}
                    title={t("templateDelete")}
                    className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/tpl:opacity-100"
                    onClick={() => handleDelete(template.id)}
                  >
                    <Trash2 className="size-3" strokeWidth={1.8} />
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>
        {/* 将当前提示词存为模板 */}
        <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-2">
          <input
            value={saveName}
            onChange={(event) => setSaveName(event.target.value)}
            placeholder={t("templateSaveNamePlaceholder")}
            className="h-7 min-w-0 flex-1 rounded-lg border border-border/70 bg-transparent px-2 text-[11px] outline-none focus:ring-1 focus:ring-primary/40"
          />
          <button
            type="button"
            disabled={!promptText.trim()}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-border/70 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-accent",
              "disabled:pointer-events-none disabled:opacity-40",
            )}
            onClick={handleSave}
          >
            <BookmarkPlus className="size-3" strokeWidth={1.8} />
            {t("templateSave")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
