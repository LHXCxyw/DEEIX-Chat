"use client";

import { useTranslations } from "next-intl";

import { PanelLeft } from "@/components/animate-ui/icons/panel-left";
import { PanelRight } from "@/components/animate-ui/icons/panel-right";
import { Button } from "@/components/ui/button";
import { useSidebar, useSidebarVisualState } from "@/components/ui/sidebar";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AppLogo } from "@/shared/components/app-logo";

export function NavControl() {
  const t = useTranslations("common.navigation");
  const { toggleSidebar, open } = useSidebar();
  const state = useSidebarVisualState();
  const isVisuallyCollapsed = state === "collapsed";
  const isPersistentlyCollapsed = !open;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="relative flex h-8 w-full items-center rounded-md text-sm">
          <span
            className={cn(
              "flex min-w-0 items-center overflow-hidden whitespace-nowrap pl-2 transition-[max-width,opacity,transform,padding-left] ease-linear",
              isVisuallyCollapsed
                ? "max-w-0 -translate-x-2 pl-0 opacity-0 duration-100"
                : "max-w-[160px] translate-x-0 pl-2 opacity-100 duration-150",
            )}
          >
            <AppLogo
              width={64}
              height={48}
              priority
              className="h-5 w-auto object-contain"
            />
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("toggleSidebar")}
                onClick={toggleSidebar}
                className={cn(
                  "shrink-0 text-sidebar-foreground transition-[background-color,color,margin-left] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring/50 [&_svg]:pointer-events-auto",
                  isVisuallyCollapsed ? "ml-0" : "ml-auto",
                )}
              >
                {isPersistentlyCollapsed ? (
                  <PanelRight aria-hidden size={18} animateOnHover strokeWidth={1.4} />
                ) : (
                  <PanelLeft aria-hidden size={18} animateOnHover strokeWidth={1.4} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" hidden={!isVisuallyCollapsed}>
              {t("toggleSidebar")}
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
