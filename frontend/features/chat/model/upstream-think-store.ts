"use client";

import * as React from "react";
import { toPendingProcessTrace } from "@/features/chat/model/message-submit";
import type { ChatMessageProcessTrace, ChatTraceBlock } from "@/features/chat/types/messages";
import type { StreamMessageEvent } from "@/shared/api/conversation.types";

type UpstreamThinkDeltaEvent = Extract<StreamMessageEvent, { type: "upstream_think_delta" }>;
type Listener = () => void;

const traces = new Map<string, ChatMessageProcessTrace>();
const listeners = new Map<string, Set<Listener>>();

function nowISO() {
  return new Date().toISOString();
}

function normalizeRunID(runID: string | null | undefined) {
  return runID?.trim() || "";
}

function mergeContent(previous: string, event: UpstreamThinkDeltaEvent) {
  if (typeof event.contentMarkdown === "string") {
    return event.contentMarkdown;
  }
  if (typeof event.delta === "string" && event.delta.length > 0) {
    return `${previous}${event.delta}`;
  }
  return previous;
}

function mergeUpstreamThinkBlock(current: ChatTraceBlock | undefined, event: UpstreamThinkDeltaEvent): ChatTraceBlock {
  const roundID = event.roundID || current?.roundID;
  const roundChanged = Boolean(roundID && current?.roundID && roundID !== current.roundID);
  const contentMarkdown = mergeContent(roundChanged ? "" : (current?.contentMarkdown ?? ""), event);
  const eventStartedAt = typeof event.startedAt === "string"
    ? event.startedAt.trim() || undefined
    : undefined;
  const eventEndedAt = typeof event.endedAt === "string"
    ? event.endedAt.trim() || undefined
    : undefined;
  return {
    title: event.title?.trim() || current?.title || "",
    summary: event.summary?.trim() || current?.summary || "",
    contentMarkdown,
    status: event.status || current?.status || "streaming",
    stage: event.stage || current?.stage || "think",
    roundID,
    parentEventID: current?.parentEventID,
    startedAt: eventStartedAt ?? (roundChanged ? undefined : current?.startedAt) ?? nowISO(),
    endedAt: eventEndedAt ?? (roundChanged ? undefined : current?.endedAt),
    updatedAt: nowISO(),
    payloadJson: current?.payloadJson,
  };
}

function mergeUpstreamThinkDeltaTrace(
  current: ChatMessageProcessTrace | undefined,
  event: UpstreamThinkDeltaEvent,
): ChatMessageProcessTrace | undefined {
  if (event.trace?.enabled) {
    const base = toPendingProcessTrace(event.trace);
    if (!base) {
      return current;
    }
    // 快照已携带历史事件，但实时思考块列表仍需保留（快照里的思考事件可能滞后）。
    return { ...base, thinkBlocks: current?.thinkBlocks ?? [] };
  }
  const previous = current?.upstreamThink;
  const upstreamThink = mergeUpstreamThinkBlock(previous, event);
  // 每一轮思考独立保留：新一轮开始（roundID 变化）时把上一轮归档进 thinkBlocks，
  // 避免“连续多轮思考只显示一个板块、历史轮次被覆盖”。
  const thinkBlocks = upsertThinkBlock(current?.thinkBlocks ?? [], upstreamThink);
  return {
    enabled: true,
    status: event.status || current?.status || "streaming",
    process: current?.process,
    tools: current?.tools,
    upstreamThink,
    thinkBlocks,
    promptTrace: current?.promptTrace,
    events: current?.events,
  };
}

function upsertThinkBlock(blocks: ChatTraceBlock[], block: ChatTraceBlock): ChatTraceBlock[] {
  const roundID = block.roundID?.trim() || "";
  if (!roundID) {
    // 无 roundID 的旧事件退化为单块语义：替换最后一个流式块或追加。
    const index = blocks.findIndex((item) => item.status === "streaming");
    if (index >= 0) {
      const next = blocks.slice();
      next[index] = block;
      return next;
    }
    return [...blocks, block];
  }
  const index = blocks.findIndex((item) => item.roundID?.trim() === roundID);
  if (index >= 0) {
    const next = blocks.slice();
    next[index] = block;
    return next;
  }
  return [...blocks, block];
}

function notify(runID: string) {
  listeners.get(runID)?.forEach((listener) => {
    listener();
  });
}

function subscribe(runID: string, listener: Listener) {
  if (!runID) {
    return () => {};
  }
  let listenersForRun = listeners.get(runID);
  if (!listenersForRun) {
    listenersForRun = new Set();
    listeners.set(runID, listenersForRun);
  }
  listenersForRun.add(listener);
  return () => {
    listenersForRun.delete(listener);
    if (listenersForRun.size === 0) {
      listeners.delete(runID);
    }
  };
}

export function readLiveUpstreamThinkTrace(runID: string | null | undefined) {
  const key = normalizeRunID(runID);
  return key ? traces.get(key) : undefined;
}

export function upsertLiveUpstreamThinkTrace(runID: string | null | undefined, event: UpstreamThinkDeltaEvent) {
  const key = normalizeRunID(runID);
  if (!key) {
    return undefined;
  }
  const next = mergeUpstreamThinkDeltaTrace(traces.get(key), event);
  if (!next) {
    return traces.get(key);
  }
  traces.set(key, next);
  notify(key);
  return next;
}

export function clearLiveUpstreamThinkTrace(runID: string | null | undefined) {
  const key = normalizeRunID(runID);
  if (!key || !traces.delete(key)) {
    return;
  }
  notify(key);
}

export function mergeLiveUpstreamThinkTrace(
  base: ChatMessageProcessTrace | undefined,
  live: ChatMessageProcessTrace | undefined,
) {
  if (!live?.upstreamThink) {
    return base;
  }
  return {
    enabled: true,
    status: live.status || base?.status || "streaming",
    process: base?.process,
    tools: base?.tools,
    upstreamThink: live.upstreamThink,
    thinkBlocks: live.thinkBlocks,
    promptTrace: base?.promptTrace,
    events: base?.events,
  };
}

export function preserveRicherLiveUpstreamThinkTrace(
  base: ChatMessageProcessTrace | undefined,
  live: ChatMessageProcessTrace | undefined,
) {
  const baseContent = base?.upstreamThink?.contentMarkdown ?? "";
  const liveContent = live?.upstreamThink?.contentMarkdown ?? "";
  if (!live?.upstreamThink || liveContent.length <= baseContent.length) {
    if (base && live?.thinkBlocks?.length && !base.thinkBlocks?.length) {
      return { ...base, thinkBlocks: live.thinkBlocks };
    }
    return base ?? live;
  }
  return mergeLiveUpstreamThinkTrace(base, live);
}

export function useLiveUpstreamThinkTrace(runID: string | null | undefined) {
  const key = normalizeRunID(runID);
  return React.useSyncExternalStore(
    React.useCallback((listener) => subscribe(key, listener), [key]),
    React.useCallback(() => readLiveUpstreamThinkTrace(key), [key]),
    (): undefined => undefined,
  );
}
