import { useEffect, useMemo, useRef } from "react";
import type { ChatMessage, Participant } from "@workspace/shared";
import { Avatar } from "./Avatar";
import { TraceMessageFinished, TraceMessageLive } from "./TraceMessage";
import type { ActiveRun, BoardLine } from "../hooks/useWorkspace";

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMentionRegex(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  return new RegExp(`@(${sorted.map(escapeRegex).join("|")})(?![\\w-])`, "g");
}

const TASK_REF_REGEX = /\btask-\d+\b/g;

export function renderContent(
  content: string,
  mentionRegex: RegExp | null,
  pill = true,
  onRefClick?: (ref: string) => void,
): React.ReactNode {
  interface Token {
    start: number;
    end: number;
    node: React.ReactNode;
  }
  const tokens: Token[] = [];
  if (mentionRegex && content.includes("@")) {
    for (const match of content.matchAll(mentionRegex)) {
      const index = match.index ?? 0;
      tokens.push({
        start: index,
        end: index + match[0].length,
        node: (
          <span
            key={`m${index}`}
            className={
              pill
                ? "rounded bg-mention-pill px-0.5 font-medium text-mention-text"
                : "rounded bg-mention-pill font-medium text-mention-text"
            }
          >
            {match[0]}
          </span>
        ),
      });
    }
  }
  for (const match of content.matchAll(TASK_REF_REGEX)) {
    const index = match.index ?? 0;
    const ref = match[0];
    tokens.push({
      start: index,
      end: index + ref.length,
      node: onRefClick ? (
        <span
          key={`t${index}`}
          onClick={() => onRefClick(ref)}
          className="cursor-pointer rounded bg-input px-1 font-semibold text-blurple"
        >
          {ref}
        </span>
      ) : (
        <span
          key={`t${index}`}
          className="rounded bg-input px-1 font-semibold text-blurple"
        >
          {ref}
        </span>
      ),
    });
  }
  if (tokens.length === 0) return content;
  tokens.sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const token of tokens) {
    if (token.start < last) continue; // skip overlapping tokens
    if (token.start > last) parts.push(content.slice(last, token.start));
    parts.push(token.node);
    last = token.end;
  }
  if (last < content.length) parts.push(content.slice(last));
  return parts;
}

function mentionsName(content: string, name: string | null): boolean {
  if (!name) return false;
  const regex = new RegExp(`@${escapeRegex(name)}(?![\\w-])`);
  return regex.test(content);
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function dayKey(ts: number): string {
  return new Date(ts).toDateString();
}

function formatDivider(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

interface Rendered {
  message: ChatMessage;
  grouped: boolean; // continuation of previous author within window
  newDay: boolean;
}

function layout(messages: ChatMessage[]): Rendered[] {
  const out: Rendered[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = messages[i - 1];
    const newDay = !prev || dayKey(prev.timestamp) !== dayKey(m.timestamp);
    const grouped =
      !newDay &&
      !!prev &&
      prev.authorId === m.authorId &&
      m.timestamp - prev.timestamp < GROUP_WINDOW_MS;
    out.push({ message: m, grouped, newDay });
  }
  return out;
}

type TimelineEntry =
  | ({ kind: "message" } & Rendered)
  | { kind: "board"; line: BoardLine };

export function MessageList({
  messages,
  boardLines,
  activeRuns,
  runDurations,
  participants,
  selfName,
  channel,
  onRefClick,
}: {
  messages: ChatMessage[];
  boardLines: BoardLine[];
  activeRuns: ActiveRun[];
  runDurations: Map<string, number>;
  participants: Participant[];
  selfName: string | null;
  // TODO(channels): channel handling is bolted on (hardcoded CHANNELS list,
  // per-message string field, client-side filtering). Needs a proper channel
  // model: server-owned channel list, scoped history/traces, per-channel reads.
  channel: string;
  onRefClick: (ref: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const mentionRegex = useMemo(
    () => buildMentionRegex(participants.map((p) => p.name)),
    [participants],
  );

  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [
      ...layout(messages).map((r) => ({ kind: "message" as const, ...r })),
      ...boardLines.map((line) => ({ kind: "board" as const, line })),
    ];
    // Stable sort: board lines interleave with messages by timestamp.
    return entries.sort(
      (a, b) =>
        (a.kind === "message" ? a.message.timestamp : a.line.ts) -
        (b.kind === "message" ? b.message.timestamp : b.line.ts),
    );
  }, [messages, boardLines]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, boardLines.length, activeRuns.length]);

  return (
    <div className="flex-1 overflow-y-auto pb-4">
      {messages.length === 0 && activeRuns.length === 0 && (
        <div className="px-4 pt-10">
          <h2 className="text-xl font-semibold text-body">{channel}</h2>
          <p className="mt-1 max-w-md text-sm text-muted">
            Nothing here yet.
            {(() => {
              const agent = participants.find((p) => p.kind === "agent");
              return agent
                ? ` Say something, or mention @${agent.name} to put it to work.`
                : " Say something to get things moving.";
            })()}
          </p>
        </div>
      )}
      {timeline.map((entry) => {
        if (entry.kind === "board") {
          return (
            <div
              key={entry.line.id}
              className="flex justify-center px-4 py-0.5 text-xs italic text-faint"
            >
              <span>
                · {renderContent(entry.line.text, null, true, onRefClick)}
              </span>
            </div>
          );
        }
        const { message: m, grouped, newDay } = entry;
        return (
        <div key={m.id} id={`msg-${m.id}`}>
          {newDay && (
            <div className="mx-4 mt-4 mb-1 flex items-center gap-2">
              <div className="h-px flex-1 bg-divider" />
              <span className="text-xs font-semibold text-muted">
                {formatDivider(m.timestamp)}
              </span>
              <div className="h-px flex-1 bg-divider" />
            </div>
          )}
          {grouped ? (
            <div
              className={`group flex gap-4 py-0.5 pr-4 pl-4 ${
                mentionsName(m.content, selfName)
                  ? "border-l-2 border-mention-accent bg-mention-bg pl-[14px] hover:bg-mention-bg-hover"
                  : "hover:bg-chat-hover"
              }`}
            >
              <div className="w-10 shrink-0 pt-1 text-right text-[10px] text-faint opacity-0 group-hover:opacity-100">
                {formatShortTime(m.timestamp)}
              </div>
              <p className="min-w-0 leading-[1.375rem] break-words whitespace-pre-wrap">
                {renderContent(m.content, mentionRegex, true, onRefClick)}
              </p>
            </div>
          ) : (
            <div
              className={`mt-4 flex gap-4 py-0.5 pr-4 pl-4 ${
                mentionsName(m.content, selfName)
                  ? "border-l-2 border-mention-accent bg-mention-bg pl-[14px] hover:bg-mention-bg-hover"
                  : "hover:bg-chat-hover"
              }`}
            >
              <div className="pt-0.5">
                <Avatar name={m.authorName} size={40} />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-body hover:underline">
                    {m.authorName}
                  </span>
                  {m.authorKind === "agent" && (
                    <span className="rounded bg-blurple px-1 py-px text-[10px] font-bold text-mention-text">
                      AGENT
                    </span>
                  )}
                  <span className="text-xs text-faint">
                    {formatTimestamp(m.timestamp)}
                  </span>
                </div>
                {m.trace ? (
                  <TraceMessageFinished
                    message={m}
                    durationMs={runDurations.get(m.runId ?? "")}
                  />
                ) : (
                  <p className="leading-[1.375rem] break-words whitespace-pre-wrap">
                    {renderContent(m.content, mentionRegex, true, onRefClick)}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
        );
      })}
      {activeRuns.map((run) => (
        <TraceMessageLive
          key={run.runId}
          runId={run.runId}
          agentName={run.agentName}
          chunks={run.chunks}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
