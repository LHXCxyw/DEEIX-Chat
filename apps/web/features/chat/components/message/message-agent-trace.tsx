"use client";

import * as React from "react";

import { Sparkles, Timer } from "lucide-react";

import { AgentTraceStep } from "@/features/chat/components/message/message-agent-trace-step";
import { ChevronDown } from "@/components/animate-ui/icons/chevron-down";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Marker, MarkerContent } from "@/components/ui/marker";
import type { ChatMessageProcessTrace, ChatTraceBlock, ChatTraceEvent } from "@/features/chat/types/messages";
import {
  useChatTraceLabels,
  type ProcessTraceLabels,
} from "@/features/chat/hooks/use-chat-trace-labels";
import {
  AgentToolStepRow,
  buildToolGroupSteps,
  isToolChainStepActive,
  type ToolChainStep,
} from "@/features/chat/components/message/message-agent-tool-step";
import { StreamdownRender } from "@/shared/components/markdown/streamdown-render";
import { useAutoExpandDisclosure } from "@/shared/hooks/use-auto-expand-disclosure";
import { cn } from "@/lib/utils";
import {
  RAGCitationList,
  TRACE_ROOT_CLASS,
  TraceContent,
} from "@/features/chat/components/shared/message-process-trace-shared";
import { useChatElapsedDurationMS } from "@/features/chat/hooks/use-chat-elapsed-duration";
import {
  durationBetweenMS,
  firstDurationMS,
  formatDurationMS,
  formatTaskDurationMS,
  sumDurationsMS,
} from "@/features/chat/model/duration";
import {
  filterProcessTraceStages,
  isRAGTraceStage,
  mergePromptTraceStage,
  parseFileContextBadges,
  parseRAGCitations,
  parseStructuredTraceStages,
  parseTraceStages,
  type TraceDisplayEvent,
} from "@/features/chat/model/message-process-trace";

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

function traceRoundGroupKey(
  event: Pick<ChatTraceEvent, "roundID" | "eventID" | "seq">,
  kind: "think" | "tool" | "text",
): string {
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
 * 思考1 → 正文1 → 工具 → 思考2 → 正文2. Think events key their own round;
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

/**
 * groupTraceDisplayEvents 的多思考块变体：实时流式期间每轮思考是独立块
 * （upstream-think-store 按轮保留），按 roundID 归入对应轮次组；未匹配的
 * （通常是当前正在流式的轮次）按稳定顺序追加在末尾。
 */
function groupTraceDisplayEventsWithThinkBlocks(
  displayEvents: TraceDisplayEvent[],
  activeThinkBlocks: ChatTraceBlock[] | undefined,
  activeThinkBlock: ChatTraceBlock | undefined,
  activeToolBlock: ChatTraceBlock | undefined,
): TraceRoundGroup[] {
  const groups = new Map<string, TraceRoundGroup>();
  for (const group of groupTraceDisplayEvents(displayEvents, activeThinkBlock, activeToolBlock)) {
    groups.set(group.key, group);
  }
  for (const block of activeThinkBlocks ?? []) {
    if (!block) {
      continue;
    }
    if (activeThinkBlock && block === activeThinkBlock) {
      continue;
    }
    const roundID = block.roundID?.trim() || "";
    const existing = roundID
      ? [...groups.values()].find((group) => group.thinkEvents.some((item) => item.event.roundID?.trim() === roundID))
      : undefined;
    if (existing) {
      existing.thinkBlock = block;
      continue;
    }
    const key = roundID ? `round:${roundID}` : `active:think:${groups.size}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, seq: Number.MAX_SAFE_INTEGER, thinkEvents: [], textEvents: [], toolEvents: [] };
      groups.set(key, group);
    }
    group.thinkBlock = block;
  }
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

// 轮次正文行：直接渲染 markdown，不折叠。
function TraceTextRow({ block }: { block: ChatTraceBlock }) {
  const text = traceBlockDisplayText(block);
  if (!text) {
    return null;
  }
  return (
    <li className="group/agent-trace-step">
      <div className="min-w-0 py-1 pl-7 pr-1 text-[15px] leading-8 text-foreground [overflow-wrap:anywhere]">
        <StreamdownRender content={text} />
      </div>
    </li>
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
    <li className="group/agent-trace-step">
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
    </li>
  );
}

function AgentTraceTimeline({
  items,
  labels,
  autoExpandThinking,
  autoExpandToolCalls,
  messageStreaming,
  runID,
  allowFullToolResults,
}: {
  items: TraceTimelineItem[];
  labels: ProcessTraceLabels;
  autoExpandThinking: boolean;
  autoExpandToolCalls: boolean;
  messageStreaming: boolean;
  runID?: string;
  allowFullToolResults: boolean;
}) {
  return (
    <div className="relative">
      <span aria-hidden className="absolute bottom-2 left-[6px] top-2 w-px bg-border/36" />
      <ol>
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
              messageStreaming={messageStreaming}
              runID={runID}
              allowFullResult={allowFullToolResults}
            />
          ),
        )}
      </ol>
    </div>
  );
}

// 轨迹时间跨度：取所有块/事件里最早的开始与最晚的结束，用于「任务耗时」。
function traceTimeBounds(
  trace: ChatMessageProcessTrace | undefined,
  events: ChatTraceEvent[],
): { startedAt?: string; endedAt?: string } {
  let minStart = Number.POSITIVE_INFINITY;
  let startedAt: string | undefined;
  let maxEnd = Number.NEGATIVE_INFINITY;
  let endedAt: string | undefined;
  const consume = (start: string | undefined, end: string | undefined) => {
    if (start) {
      const value = new Date(start).getTime();
      if (Number.isFinite(value) && value < minStart) {
        minStart = value;
        startedAt = start;
      }
    }
    if (end) {
      const value = new Date(end).getTime();
      if (Number.isFinite(value) && value > maxEnd) {
        maxEnd = value;
        endedAt = end;
      }
    }
  };
  const blocks: (ChatTraceBlock | undefined)[] = [trace?.process, trace?.upstreamThink, trace?.tools];
  for (const block of trace?.thinkBlocks ?? []) {
    blocks.push(block);
  }
  for (const block of blocks) {
    consume(block?.startedAt, block?.endedAt);
  }
  for (const event of events) {
    consume(event.startedAt, event.endedAt);
  }
  return { startedAt, endedAt };
}

// 任务耗时折叠：把处理轨迹（文件/检索/压缩）与 agent 轮次（思考→中间轮正文→工具）
// 合并到单个折叠里；折叠态只露出标题，最终正文由 message-bot 的正文区块照常渲染。
export function MessageTaskTrace({
  trace,
  events: traceEvents,
  activeToolBlock,
  activeThinkBlock,
  activeThinkBlocks,
  messageStreaming,
  autoCollapseReady,
  autoExpandThinking = true,
  autoExpandToolCalls = true,
  runID,
  allowFullToolResults = false,
  showProcessTrace = true,
  detailPending = false,
  detailFailed = false,
  onLoadDetail,
}: {
  trace?: ChatMessageProcessTrace;
  events: ChatTraceEvent[];
  activeToolBlock?: ChatTraceBlock;
  activeThinkBlock?: ChatTraceBlock;
  activeThinkBlocks?: ChatTraceBlock[];
  messageStreaming: boolean;
  autoCollapseReady: boolean;
  autoExpandThinking?: boolean;
  autoExpandToolCalls?: boolean;
  runID?: string;
  allowFullToolResults?: boolean;
  showProcessTrace?: boolean;
  detailPending?: boolean;
  detailFailed?: boolean;
  onLoadDetail?: () => void;
}) {
  const labels = useChatTraceLabels();
  const displayEvents = React.useMemo(() => buildTraceDisplayEvents(traceEvents), [traceEvents]);
  const groups = React.useMemo(
    () => groupTraceDisplayEventsWithThinkBlocks(displayEvents, activeThinkBlocks, activeThinkBlock, activeToolBlock),
    [activeThinkBlocks, activeThinkBlock, activeToolBlock, displayEvents],
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
        const completedDurationMS =
          thinkEventDurationMS(group.thinkEvents) ?? durationBetweenMS(thinkBlock.startedAt, thinkBlock.endedAt);
        list.push({
          kind: "think",
          key: `${group.key}:think`,
          block: thinkBlock,
          streaming,
          durationMS: streaming ? undefined : completedDurationMS,
        });
      }
      for (const textEvent of group.textEvents) {
        list.push({
          kind: "text",
          key: `${group.key}:text:${textEvent.event.eventID || textEvent.event.seq}`,
          block: traceEventToBlock(textEvent.event),
        });
      }
      groupToolSteps[index].forEach((step) => {
        const occurrence = toolKeyOccurrences.get(step.key) || 0;
        toolKeyOccurrences.set(step.key, occurrence + 1);
        list.push({ kind: "tool", key: `tool:${step.key}:${occurrence}`, step });
      });
    });
    return list;
  }, [groupToolSteps, groups, messageStreaming]);

  const hasActiveStep = items.some((item) =>
    item.kind === "think" ? item.streaming : item.kind === "tool" ? isToolChainStepActive(item.step) : false,
  );
  const processStreaming = Boolean(messageStreaming && trace?.process?.status === "streaming");
  const traceRunActive = messageStreaming && (hasActiveStep || processStreaming || !autoCollapseReady);
  const { open, onOpenChange } = useAutoExpandDisclosure({
    active: traceRunActive,
    autoExpand: true,
    collapseReady: autoCollapseReady || !messageStreaming,
  });

  React.useEffect(() => {
    if (open && detailPending && !detailFailed) onLoadDetail?.();
  }, [open, detailPending, detailFailed, onLoadDetail]);

  // 处理轨迹内容（文件上下文/内容检索/上下文压缩/Prompt 规划），受「显示处理轨迹」设置控制。"{"
  const process = trace?.process;
  const citations = process ? parseRAGCitations(process.payloadJson) : [];
  const fileBadges = process ? parseFileContextBadges(process.payloadJson, labels) : [];
  const structuredStages = process ? parseStructuredTraceStages(process.payloadJson, labels) : [];
  const parsedStages = process && structuredStages.length === 0 ? parseTraceStages(process.contentMarkdown) : [];
  const stages = process
    ? filterProcessTraceStages(
        mergePromptTraceStage(
          structuredStages.length > 0 ? structuredStages : parsedStages,
          trace?.promptTrace,
          labels,
        ),
      )
    : [];
  const hasRAGStage = stages.some(isRAGTraceStage);
  const hasRenderableProcessContent =
    Boolean(process) && (stages.length > 0 || Boolean(process?.contentMarkdown.trim() && parsedStages.length === 0));
  const hasProcessContent =
    Boolean(showProcessTrace && trace?.enabled && process) &&
    (hasRenderableProcessContent || citations.length > 0 || Boolean(trace?.promptTrace));

  const bounds = React.useMemo(() => traceTimeBounds(trace, traceEvents), [trace, traceEvents]);
  const liveElapsedMS = useChatElapsedDurationMS(traceRunActive, bounds.startedAt);
  const stepDurationMS = sumDurationsMS(
    items.map((item) => (item.kind === "think" ? item.durationMS : item.kind === "tool" ? item.step.latencyMS : 0)),
  );
  const completedDurationMS = firstDurationMS(durationBetweenMS(bounds.startedAt, bounds.endedAt), stepDurationMS);
  const durationText = formatTaskDurationMS(traceRunActive ? liveElapsedMS : completedDurationMS);
  const title = durationText ? labels.process.taskDuration(durationText) : labels.process.taskTitle;

  if (items.length === 0 && !hasProcessContent && !detailPending) {
    return null;
  }

  return (
    <div className={TRACE_ROOT_CLASS}>
      <Accordion
        type="single"
        collapsible
        value={open ? "message-task-trace" : ""}
        onValueChange={(value) => onOpenChange(value === "message-task-trace")}
        className="w-full"
      >
        <AccordionItem value="message-task-trace" className="border-b-0">
          <AccordionTrigger
            iconPosition="none"
            className="group/trace min-h-0 items-center justify-between gap-1.5 py-0.5 text-left no-underline hover:no-underline"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <Timer
                className={cn("size-3.5 shrink-0 text-muted-foreground/68", traceRunActive && "text-foreground/78")}
              />
              <Marker
                render={<span />}
                className={cn(
                  "inline-flex min-h-0 w-auto text-[13px] font-medium transition-colors",
                  !traceRunActive && "text-muted-foreground group-hover/trace:text-foreground",
                )}
              >
                <MarkerContent className={cn("min-w-0", traceRunActive && "shimmer")}>{title}</MarkerContent>
              </Marker>
            </div>
            <ChevronDown
              className={cn(
                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground",
                open && "rotate-180",
              )}
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-2.5 px-0 pb-0 pt-1.5 duration-[350ms] ease-in-out">
            {detailPending ? (
              <div role="status" className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                <span>{detailFailed ? labels.run.detailFailed : labels.run.detailLoading}</span>
                {detailFailed ? (
                  <button type="button" className="rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring" onClick={onLoadDetail}>
                    {labels.run.detailRetry}
                  </button>
                ) : null}
              </div>
            ) : null}
            {!detailPending && hasProcessContent && process ? (
              <>
                <TraceContent
                  block={process}
                  streaming={processStreaming}
                  citations={citations}
                  fileBadges={fileBadges}
                  promptTrace={trace?.promptTrace}
                  labels={labels}
                />
                {!hasRAGStage ? <RAGCitationList citations={citations} labels={labels} /> : null}
              </>
            ) : null}
            {!detailPending && items.length > 0 ? (
              <AgentTraceTimeline
                items={items}
                labels={labels}
                autoExpandThinking={autoExpandThinking}
                autoExpandToolCalls={autoExpandToolCalls}
                messageStreaming={messageStreaming}
                runID={runID}
                allowFullToolResults={allowFullToolResults}
              />
            ) : null}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
