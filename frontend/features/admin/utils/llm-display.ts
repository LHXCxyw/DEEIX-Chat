import type { AdminLLMAdapter } from "@/features/admin/api/llm.types";
import { COMPATIBLE_PRESETS, PROTOCOL_PRESETS } from "@/shared/lib/llm-presets";

// 模型类型枚举；展示文案统一走 i18n（adminModels/adminUpstreams 命名空间下的 kinds.*），此处不维护英文 label。
export const MODEL_KINDS = [
  "chat",
  "audio",
  "image_gen",
  "image_edit",
  "video_gen",
  "video_extension",
] as const;

export const COMPATIBLE_OPTIONS = COMPATIBLE_PRESETS;

type ProtocolOption = {
  value: AdminLLMAdapter;
  label: string;
  kinds: readonly string[];
};

export const PROTOCOL_OPTIONS: ReadonlyArray<ProtocolOption> = PROTOCOL_PRESETS as ReadonlyArray<ProtocolOption>;

const PROTOCOL_LABELS: Record<string, string> = {
  ...Object.fromEntries(PROTOCOL_OPTIONS.map((item) => [item.value, item.label])),
};

const PROTOCOL_KINDS: Record<string, readonly string[]> = {
  ...Object.fromEntries(PROTOCOL_OPTIONS.map((item) => [item.value, item.kinds])),
};

const PROTOCOL_DISPLAY_ORDER = new Map<string, number>(
  PROTOCOL_OPTIONS.map((item, index) => [item.value, index]),
);

const IMAGE_ROUTE_PROTOCOL_PAIRS: ReadonlyArray<readonly [AdminLLMAdapter, AdminLLMAdapter]> = [
  ["openai_image_generations", "openai_image_edits"],
  ["openai_image_generations", "image_edits_json"],
  ["xai_image", "xai_image_edits"],
];

const VIDEO_ROUTE_PROTOCOL_PAIRS: ReadonlyArray<readonly [AdminLLMAdapter, AdminLLMAdapter]> = [
  ["xai_video", "xai_video_extensions"],
];

// 协议名为技术专有名词（对应上游 API 端点），保持英文展示，不参与翻译。
export function resolveProtocolLabel(protocol: string): string {
  return PROTOCOL_LABELS[protocol] ?? protocol;
}

export function sortProtocolsForDisplay<T extends string>(protocols: readonly T[]): T[] {
  const seen = new Set<string>();
  return protocols
    .map((protocol, index) => ({ protocol, index }))
    .filter(({ protocol }) => {
      const key = String(protocol || "").trim();
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const orderA = PROTOCOL_DISPLAY_ORDER.get(a.protocol);
      const orderB = PROTOCOL_DISPLAY_ORDER.get(b.protocol);
      if (orderA !== undefined && orderB !== undefined) {
        return orderA - orderB;
      }
      if (orderA !== undefined) {
        return -1;
      }
      if (orderB !== undefined) {
        return 1;
      }
      return a.index - b.index;
    })
    .map(({ protocol }) => protocol);
}

export function isSupportedRouteProtocolSelection(protocols: readonly AdminLLMAdapter[]): boolean {
  const uniqueProtocols = Array.from(new Set(protocols));
  if (uniqueProtocols.length <= 1) {
    return true;
  }
  return uniqueProtocols.length === 2 && [...IMAGE_ROUTE_PROTOCOL_PAIRS, ...VIDEO_ROUTE_PROTOCOL_PAIRS].some(
    ([primaryProtocol, secondaryProtocol]) =>
      uniqueProtocols.includes(primaryProtocol) && uniqueProtocols.includes(secondaryProtocol),
  );
}

export function resolveNextRouteProtocolSelection(
  currentProtocols: readonly AdminLLMAdapter[],
  protocol: AdminLLMAdapter,
): AdminLLMAdapter[] {
  const current = sortProtocolsForDisplay(currentProtocols);
  if (current.includes(protocol)) {
    return sortProtocolsForDisplay(current.filter((item) => item !== protocol));
  }
  const candidate = sortProtocolsForDisplay([...current, protocol]);
  if (isSupportedRouteProtocolSelection(candidate)) {
    return candidate;
  }
  return [protocol];
}

export function resolveKindsDisplayForProtocols(
  protocols: readonly AdminLLMAdapter[],
  fallbackDisplay = "chat",
): string {
  const kinds = Array.from(new Set(protocols.flatMap((protocol) => PROTOCOL_KINDS[protocol] ?? [])));
  return kinds.length > 0 ? kinds.join(",") : fallbackDisplay;
}

export function resolveCompatibleLabel(compatible: string): string {
  return COMPATIBLE_OPTIONS.find((item) => item.value === compatible)?.label ?? (compatible || "-");
}
