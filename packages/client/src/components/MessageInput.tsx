import { useEffect, useMemo, useRef, useState } from "react";
import { buildMentionRegex, renderContent } from "./MessageList";
import type { Participant } from "@workspace/shared";
import { Avatar } from "./Avatar";

export interface Prefill {
  text: string;
  nonce: number;
}

interface MentionQuery {
  start: number; // index of the '@' in the draft
  query: string;
}

interface SlashCommand {
  name: string;
  description: string;
}

const COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Clear all messages in the channel" },
  { name: "interrupt", description: "Interrupt an agent and redirect it: /interrupt @agent new prompt" },
];

function findCommandQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const query = text.slice(1);
  if (/\s/.test(query)) return null;
  return query;
}

function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  // '@' must be at the start or preceded by whitespace
  if (at > 0 && !/\s/.test(upToCaret[at - 1])) return null;
  const query = upToCaret.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

export function MessageInput({
  channel,
  participants,
  onSend,
  prefill,
}: {
  channel: string;
  participants: Participant[];
  onSend: (content: string) => void;
  prefill?: Prefill | null;
}) {
  const [draft, setDraft] = useState("");
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setDraft((prev) => {
      if (prev.includes(prefill.text.trim())) return prev;
      const sep = prev && !prev.endsWith(" ") ? " " : "";
      return prev + sep + prefill.text;
    });
    inputRef.current?.focus();
  }, [prefill]);

  const mentionRegex = useMemo(
    () => buildMentionRegex(participants.map((p) => p.name)),
    [participants],
  );

  const matches = mention
    ? participants.filter((p) =>
        p.name.toLowerCase().startsWith(mention.query.toLowerCase()),
      )
    : [];
  const mentionOpen = mention !== null && matches.length > 0;

  const commandQuery = findCommandQuery(draft);
  const commandMatches =
    commandQuery !== null
      ? COMMANDS.filter((c) =>
          c.name.toLowerCase().startsWith(commandQuery.toLowerCase()),
        )
      : [];
  const commandOpen =
    !mentionOpen && !commandDismissed && commandMatches.length > 0;

  const updateMention = (value: string, caret: number | null) => {
    setMention(findMentionQuery(value, caret ?? value.length));
    setCommandDismissed(false);
    setHighlighted(0);
  };

  const pickMention = (p: Participant) => {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const next =
      draft.slice(0, mention.start) + `@${p.name} ` + draft.slice(caret);
    setDraft(next);
    setMention(null);
    inputRef.current?.focus();
  };

  const pickCommand = (c: SlashCommand) => {
    setDraft(`/${c.name}`);
    inputRef.current?.focus();
  };

  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft("");
    setMention(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mentionOpen) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(matches[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    } else if (commandOpen) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted(
          (h) => (h - 1 + commandMatches.length) % commandMatches.length,
        );
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % commandMatches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        pickCommand(commandMatches[highlighted]);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onSend(`/${commandMatches[highlighted].name}`);
        setDraft("");
        return;
      }
      if (e.key === "Escape") {
        setCommandDismissed(true);
        return;
      }
    }
    if (e.key === "Enter") submit();
  };

  return (
    <div className="relative shrink-0 px-4 pb-6">
      {commandOpen && (
        <div className="absolute bottom-full left-4 right-4 z-10 mb-2 overflow-hidden rounded-lg bg-popup shadow-lg">
          <div className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
            Commands
          </div>
          <ul className="max-h-64 overflow-y-auto p-1.5 pt-0">
            {commandMatches.map((c, i) => (
              <li key={c.name}>
                <button
                  className={`flex w-full items-center gap-3 rounded px-2 py-1.5 text-left ${
                    i === highlighted ? "bg-input" : ""
                  }`}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickCommand(c);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-body">/{c.name}</div>
                    <div className="truncate text-xs text-muted">
                      {c.description}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-faint">Built-in</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {mentionOpen && (
        <div className="absolute bottom-full left-4 right-4 z-10 mb-2 overflow-hidden rounded-lg bg-popup shadow-lg">
          <div className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
            Members
          </div>
          <ul className="max-h-64 overflow-y-auto p-1.5 pt-0">
            {matches.map((p, i) => (
              <li key={p.id}>
                <button
                  className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left ${
                    i === highlighted ? "bg-input text-body" : "text-body"
                  }`}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(p);
                  }}
                >
                  <Avatar name={p.name} size={24} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.kind === "agent" && (
                    <span className="rounded bg-blurple px-1 py-px text-[10px] font-bold text-mention-text">
                      AGENT
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-3 rounded-lg bg-input px-4">
        <button
          className="shrink-0 text-muted transition hover:text-blurple"
          title="Attach"
        >
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
          </svg>
        </button>
        <div className="relative min-w-0 flex-1">
          <div
            ref={displayRef}
            className="pointer-events-none min-w-0 overflow-hidden whitespace-pre py-2.5 text-body"
          >
            {!draft && <span className="text-faint">{`Write in ${channel}…`}</span>}
            {draft && renderContent(draft, mentionRegex, false)}
          </div>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => setMention(null)}
            onScroll={(e) => {
              if (displayRef.current) {
                displayRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            className="absolute inset-0 w-full bg-transparent py-2.5 text-transparent outline-none"
            style={{ caretColor: "var(--color-body)" }}
            placeholder=""
            maxLength={4000}
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 text-muted">
          <button className="transition hover:text-blurple" title="GIF">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M8 10v4M8 10h2M8 12h1.5M12 10v4M15 14v-4h2.5M15 12h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button className="transition hover:text-blurple" title="Emoji">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
              <path d="M8.5 14.5a4.5 4.5 0 007 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="9" cy="10" r="1.25" fill="currentColor" />
              <circle cx="15" cy="10" r="1.25" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
