import { Blend } from "@/components/animate-ui/icons/blend";
import { BookOpen } from "@/components/animate-ui/icons/book-open";
import { Layers } from "@/components/animate-ui/icons/layers";
import { MessageCircleMore } from "@/components/animate-ui/icons/message-circle-more";
import { Search } from "@/components/animate-ui/icons/search";
import { Sparkles } from "@/components/animate-ui/icons/sparkles";
import { PlusIcon } from "@/components/ui/plus";
import type { NavigationItem } from "@/features/layouts/types/navigation";

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
    id: "canvasStudio",
    kind: "link",
    href: "/canvas",
    icon: Sparkles,
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
    href: "/knowledges",
    icon: BookOpen,
    group: "secondary",
  },
  {
    id: "skillsPrompt",
    kind: "link",
    href: "/skills-prompt",
    icon: Blend,
    group: "secondary",
  },
] as const satisfies readonly NavigationItem[];
