"use client";


import { Sparkles } from "lucide-react";
import * as React from "react";
import {
  AgentToolStepRow,
  buildToolGroupSteps,
  isToolChainStepActive,
  type ToolChainStep,
} from "@/features/chat/components/message/message-agent-tool-step";
import { AgentTraceStep } from "@/features/chat/components/message/message-agent-trace-step";
import { TRACE_ROOT_CLASS } from "@/features/chat/components/shared/message-process-trace-shared";
import { useChatElapsedDurationMS } from "@/features/chat/hooks/use-chat-elapsed-duration";
import {
  type ProcessTraceLabels,
  useChatTraceLabels,
} from "@/features/chat/hooks/use-chat-trace-labels";
import {
  durationBetweenMS,
  formatDurationMS,
  sumDurationsMS,
} from "@/features/chat/model/duration";
import type { TraceDisplayEvent } from "@/features/chat/model/message-process-trace";
import type { ChatTraceBlock, ChatTraceEvent } from "@/features/chat/types/messages";
import { cn } from "@/lib/utils";
import { StreamdownRender } from "@/shared/components/markdown/streamdown-render";
import { useAutoExpandDisclosure } from "@/shared/hooks/use-auto-expand-disclosure";

function traceEventToBlock(event: ChatTraceEvent): ChatTraceBlock {
  return {
    title: event.title,
    summary: event.summary,
    contentMarkdown: event.contentMarkdown,
    status: event.status,
    stage: event.stage,
    roundID: event.roundID,
    parentEventID: event.parentEventID,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    updatedAt: event.updatedAt,
    payloadJson: event.payloadJson,
  };
}

function isToolTraceEvent(event: ChatTraceEvent): boolean {
  if (event.eventType === "text") {
    return false;
  }
  if (event.stage === "think" || event.phase === "upstream_think" || event.eventType === "think") {
    return false;
  }
  return event.stage === "tool" || event.phase === "tools" || event.eventType === "tool";
}

function isThinkTraceEvent(event: ChatTraceEvent): boolean {
  if (event.eventType === "text") {
    return false;
  }
  return event.stage === "think" || event.phase === "upstream_think" || event.eventType === "think";
}

// 轮次正文事件：agent 循环中间轮的正文，按 思考→正文→工具 的顺序穿插显示。
function isTextTraceEvent(event: ChatTraceEvent): boolean {
  return event.eventType === "text";
}

function buildTraceDisplayEvents(events: ChatTraceEvent[]): TraceDisplayEvent[] {
  return events
    .filter((event) => isToolTraceEvent(event) || isThinkTraceEvent(event) || isTextTraceEvent(event))
    .sort((left, right) => left.seq - right.seq)
    .map((event) => {
      if (isThinkTraceEvent(event)) {
        return { event, kind: "think" };
      }
      if (isTextTraceEvent(event)) {
        return { event, kind: "text" };
      }
      return { event, kind: "tool" };
    });
}

function traceBlockDisplayText(block: Pick<ChatTraceBlock, "contentMarkdown" | "summary">): string {
  return block.contentMarkdown?.trim() || block.summary?.trim() || "";
}

type OrderedThinkBlock = ChatTraceBlock & {
  seq: number;
};

function mergeThinkTraceBlock(events: TraceDisplayEvent[], activeThinkBlock?: ChatTraceBlock): ChatTraceBlock | undefined {
  const blocks: OrderedThinkBlock[] = events
    .filter((item) => item.kind === "think")
    .map((item) => ({ ...traceEventToBlock(item.event), seq: item.event.seq }));

  if (activeThinkBlock) {
    const activeText = traceBlockDisplayText(activeThinkBlock);
    const activeIndex = blocks.findIndex((block) => {
      const sameRound = Boolean(activeThinkBlock.roundID && block.roundID === activeThinkBlock.roundID);
      const sameParent = Boolean(activeThinkBlock.parentEventID && block.parentEventID === activeThinkBlock.parentEventID);
      const sameText = Boolean(activeText && traceBlockDisplayText(block) === activeText);
      return sameRound || sameParent || sameText;
    });
    if (activeIndex >= 0) {
      blocks[activeIndex] = { ...activeThinkBlock, seq: blocks[activeIndex].seq };
    } else {
      blocks.push({ ...activeThinkBlock, seq: Number.MAX_SAFE_INTEGER });
    }
  }

  if (blocks.length === 0) {
    return undefined;
  }

  const ordered = [...blocks].sort((left, right) => left.seq - right.seq);
  const parts: string[] = [];
  for (const block of ordered) {
    const text = traceBlockDisplayText(block);
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }

  const latest = ordered[ordered.length - 1];
  return {
    ...latest,
    stage: "think",
    status: ordered.some((block) => block.status === "streaming") ? "streaming" : latest.status || "completed",
    contentMarkdown: parts.join("\n\n"),
    contentSegments: parts,
  };
}

type TraceRoundGroup = {
  key: string;
  seq: number;
  thinkEvents: TraceDisplayEvent[];
  textEvents: TraceDisplayEvent[];
  toolEvents: TraceDisplayEvent[];
  thinkBlock?: ChatTraceBlock;
  toolBlock?: ChatTraceBlock;
};

function traceRoundGroupKey(event: Pick<ChatTraceEvent, "roundID" | "eventID" | "seq">, kind: "think" | "tool" | "text"): string {
  const roundID = event.roundID?.trim() || "";
  if (roundID) {
    return `round:${roundID}`;
  }
  const eventID = event.eventID?.trim() || "";
  if (kind === "think" && eventID) {
    return `parent:${eventID}`;
  }
  return `${kind}:${eventID || event.seq}`;
}

/**
 * Group think, round-text and tool events into agent-loop rounds so each round's
 * thinking, body text and tool calls render in chronological order:
 * 思考1 → 正文1 → 思考2 → 工具 → 正文2. Think events key their own round;
 * text/tool events join the preceding think round via roundID / parentEventID
 * and keep a standalone group when the round ran without thinking.
 */
function groupTraceDisplayEvents(
  displayEvents: TraceDisplayEvent[],
  activeThinkBlock?: ChatTraceBlock,
  activeToolBlock?: ChatTraceBlock,
): TraceRoundGroup[] {
  const groups = new Map<string, TraceRoundGroup>();
  const thinkEventIDToKey = new Map<string, string>();
  const thinkRoundIDToKey = new Map<string, string>();

  const ensureGroup = (key: string, seq: number): TraceRoundGroup => {
    let group = groups.get(key);
    if (!group) {
      group = { key, seq, thinkEvents: [], textEvents: [], toolEvents: [] };
      groups.set(key, group);
    } else if (seq < group.seq) {
      group.seq = seq;
    }
    return group;
  };

  for (const item of displayEvents) {
    if (item.kind !== "think") {
      continue;
    }
    const key = traceRoundGroupKey(item.event, "think");
    ensureGroup(key, item.event.seq).thinkEvents.push(item);
    if (item.event.roundID?.trim()) {
      thinkRoundIDToKey.set(item.event.roundID.trim(), key);
    }
    if (item.event.eventID) {
      thinkEventIDToKey.set(item.event.eventID, key);
    }
  }

  for (const item of displayEvents) {
    if (item.kind !== "text" && item.kind !== "tool") {
      continue;
    }
    const roundID = item.event.roundID?.trim() || "";
    const parentID = item.event.parentEventID?.trim() || "";
    const key =
      (roundID && thinkRoundIDToKey.get(roundID)) ||
      (parentID && thinkEventIDToKey.get(parentID)) ||
      traceRoundGroupKey(item.event, item.kind);
    const group = ensureGroup(key, item.event.seq);
    if (item.kind === "text") {
      group.textEvents.push(item);
    } else {
      group.toolEvents.push(item);
    }
  }

  // Snapshot blocks enrich their matching event round; unmatched live fallbacks are appended last.
  const attachActiveBlock = (block: ChatTraceBlock | undefined, kind: "think" | "tool") => {
    if (!block) {
      return;
    }
    const roundID = block.roundID?.trim() || "";
    const parentID = block.parentEventID?.trim() || "";
    let matchedKey = (roundID && thinkRoundIDToKey.get(roundID)) || (parentID && thinkEventIDToKey.get(parentID));
    if (!matchedKey && kind === "think") {
      const blockText = traceBlockDisplayText(block);
      if (blockText) {
        for (const [key, group] of groups) {
          if (
            group.thinkEvents.some(
              (item) => traceBlockDisplayText(item.event) === blockText,
            )
          ) {
            matchedKey = key;
          }
        }
      }
    }
    if (matchedKey) {
      const matched = groups.get(matchedKey);
      if (matched) {
        if (kind === "think") {
          matched.thinkBlock = block;
        } else {
          matched.toolBlock = block;
        }
        return;
      }
    }
    const key = roundID
      ? `round:${roundID}`
      : parentID
        ? `parent:${parentID}`
        : `active:${kind}`;
    const group = ensureGroup(key, Number.MAX_SAFE_INTEGER);
    if (kind === "think") {
      group.thinkBlock = block;
    } else {
      group.toolBlock = block;
    }
  };
  attachActiveBlock(activeThinkBlock, "think");
  attachActiveBlock(activeToolBlock, "tool");

  return [...groups.values()].sort((left, right) => left.seq - right.seq);
}

function thinkEventDurationMS(thinkEvents: TraceDisplayEvent[]): number | undefined {
  return sumDurationsMS(
    thinkEvents.map(({ event }) => durationBetweenMS(event.startedAt, event.endedAt)),
  );
}

type TraceTimelineItem =
  | { kind: "think"; key: string; block: ChatTraceBlock; streaming: boolean; durationMS?: number }
  | { kind: "text"; key: string; block: ChatTraceBlock }
  | { kind: "tool"; key: string; step: ToolChainStep };

function TraceTextRow({ block }: { block: ChatTraceBlock }) {
  const text = traceBlockDisplayText(block);
  if (!text) {
    return null;
  }
  return (
    <div className="min-w-0 py-1 pl-6 pr-1 text-[15px] leading-8 text-foreground [overflow-wrap:anywhere]">
      <StreamdownRender content={text} />
    </div>
  );
}

function TraceThinkRow({
  block,
  streaming,
  durationMS,
  autoExpand,
  labels,
}: {
  block: ChatTraceBlock;
  streaming: boolean;
  durationMS?: number;
  autoExpand: boolean;
  labels: ProcessTraceLabels;
}) {
  const { open, onOpenChange } = useAutoExpandDisclosure({
    active: streaming,
    autoExpand,
  });

  const liveDurationMS = useChatElapsedDurationMS(streaming, block.startedAt);
  const durationText = formatDurationMS(streaming ? liveDurationMS : durationMS);

  return (
    <div className="group/agent-trace-step">
      <AgentTraceStep
        icon={
          <Sparkles
            className={cn(
              "size-3 text-muted-foreground/68",
              streaming && "text-foreground/78",
            )}
          />
        }
        title={streaming ? labels.think.rowActive : labels.think.rowDone}
        duration={durationText ? labels.think.duration(durationText) : undefined}
        open={open}
        expandable
        loading={streaming}
        onOpenChange={onOpenChange}
      >
        <StreamdownRender content={block.contentMarkdown} streaming={streaming} variant="thinking" />
      </AgentTraceStep>
    </div>
  );
}

function AgentTraceTimeline({
  items,
  labels,
  autoExpandThinking,
  autoExpandToolCalls,
  runID,
  allowFullToolResults,
}: {
  items: TraceTimelineItem[];
  labels: ProcessTraceLabels;
  autoExpandThinking: boolean;
  autoExpandToolCalls: boolean;
  runID?: string;
  allowFullToolResults: boolean;
}) {
  return (
    <div className="flex flex-col items-stretch">
      {items.map((item) =>
        item.kind === "think" ? (
          <TraceThinkRow
            key={item.key}
            block={item.block}
            streaming={item.streaming}
            durationMS={item.durationMS}
            autoExpand={autoExpandThinking}
            labels={labels}
          />
        ) : item.kind === "text" ? (
          <TraceTextRow key={item.key} block={item.block} />
        ) : (
          <AgentToolStepRow
            key={item.key}
            step={item.step}
            labels={labels}
            autoExpand={autoExpandToolCalls}
            runID={runID}
            allowFullResult={allowFullToolResults}
          />
        ),
      )}
    </div>
  );
}

export function MessageAgentTrace({
  events: traceEvents,
  activeToolBlock,
  activeThinkBlock,
  messageStreaming,
  autoExpandThinking = true,
  autoExpandToolCalls = true,
  runID,
  allowFullToolResults = false,
}: {
  events: ChatTraceEvent[];
  activeToolBlock?: ChatTraceBlock;
  activeThinkBlock?: ChatTraceBlock;
  messageStreaming: boolean;
  autoCollapseReady?: boolean;
  autoExpandThinking?: boolean;
  autoExpandToolCalls?: boolean;
  runID?: string;
  allowFullToolResults?: boolean;
}) {
  const labels = useChatTraceLabels();
  const displayEvents = React.useMemo(() => buildTraceDisplayEvents(traceEvents), [traceEvents]);
  const groups = React.useMemo(
    () => groupTraceDisplayEvents(displayEvents, activeThinkBlock, activeToolBlock),
    [activeThinkBlock, activeToolBlock, displayEvents],
  );
  const groupToolSteps = React.useMemo(
    () => groups.map((group) => buildToolGroupSteps(group.toolEvents, group.toolBlock, labels)),
    [groups, labels],
  );
  const items = React.useMemo<TraceTimelineItem[]>(() => {
    const list: TraceTimelineItem[] = [];
    const toolKeyOccurrences = new Map<string, number>();
    groups.forEach((group, index) => {
      const thinkBlock = mergeThinkTraceBlock(group.thinkEvents, group.thinkBlock);
      if (thinkBlock) {
        const streaming = Boolean(messageStreaming && thinkBlock.status === "streaming");
        const completedDurationMS = thinkEventDurationMS(group.thinkEvents)
          ?? durationBetweenMS(thinkBlock.startedAt, thinkBlock.endedAt);
        list.push({
          kind: "think",
          key: `${group.key}:think`,
          block: thinkBlock,
          streaming,
          durationMS: streaming
            ? undefined
            : completedDurationMS,
        });
      }
      for (const textEvent of group.textEvents) {
        list.push({ kind: "text", key: `${group.key}:text:${textEvent.event.eventID || textEvent.event.seq}`, block: traceEventToBlock(textEvent.event) });
      }
      groupToolSteps[index].forEach((step) => {
        const occurrence = toolKeyOccurrences.get(step.key) || 0;
        toolKeyOccurrences.set(step.key, occurrence + 1);
        list.push({ kind: "tool", key: `tool:${step.key}:${occurrence}`, step });
      });
    });
    return list;
  }, [groupToolSteps, groups, messageStreaming]);

  if (items.length === 0) {
    return null;
  }

  // 不再使用外层折叠面板：思考、正文、工具调用每条独立展开/收起，
  // 按时间顺序直接铺在消息流里。
  return (
    <div className={TRACE_ROOT_CLASS}>
      <AgentTraceTimeline
        items={items}
        labels={labels}
        autoExpandThinking={autoExpandThinking}
        autoExpandToolCalls={autoExpandToolCalls}
        runID={runID}
        allowFullToolResults={allowFullToolResults}
      />
    </div>
  );
}
