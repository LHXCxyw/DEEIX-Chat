import { Frame } from "lucide-react";
import * as React from "react";

import { Blend } from "@/components/animate-ui/icons/blend";
import { BookOpen } from "@/components/animate-ui/icons/book-open";
import { Layers } from "@/components/animate-ui/icons/layers";
import { MessageCircleMore } from "@/components/animate-ui/icons/message-circle-more";
import { Search } from "@/components/animate-ui/icons/search";
import { PlusIcon } from "@/components/ui/plus";
import type { NavigationIconProps, NavigationItem } from "@/features/shell/types/navigation";

// 画布入口使用 Lucide 图标；导航图标契约携带 animate 动画参数，这里做一次适配并忽略该项。
function CanvasNavIcon({ size, strokeWidth, className, "aria-hidden": ariaHidden }: NavigationIconProps) {
  return React.createElement(Frame, { size, strokeWidth, className, "aria-hidden": ariaHidden });
}

export const NAVIGATION_ITEMS = [
  {
    id: "newChat",
    kind: "command",
    icon: PlusIcon,
    variant: "primary",
    group: "primary",
    shortcut: ["command", "shift", "O"],
  },
  {
    id: "search",
    kind: "command",
    icon: Search,
    group: "primary",
    shortcut: ["command", "K"],
  },
  {
    id: "recent",
    kind: "link",
    href: "/recent",
    icon: MessageCircleMore,
    group: "secondary",
  },
  {
    id: "files",
    kind: "link",
    href: "/files",
    icon: Layers,
    group: "secondary",
  },
  {
    id: "knowledgeBases",
    kind: "link",
    href: "/knowledge-bases",
    icon: BookOpen,
    group: "secondary",
  },
  {
    id: "library",
    kind: "link",
    href: "/library",
    icon: Blend,
    group: "secondary",
  },
  {
    id: "canvas",
    kind: "link",
    href: "/canvas",
    icon: CanvasNavIcon,
    group: "secondary",
  },
] as const satisfies readonly NavigationItem[];
