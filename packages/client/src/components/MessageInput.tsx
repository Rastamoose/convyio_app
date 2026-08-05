import { useEffect, useMemo, useRef, useState } from "react";
import type { Participant } from "@workspace/shared";
import { buildMentionRegex, renderContent } from "./MessageList";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";

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
  onSend,
  prefill,
}: {
  channel: string;
  onSend: (content: string) => void;
  prefill?: Prefill | null;
}) {
  const { participants } = useWorkspace();
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
                  {p.kind === "agent" && <AgentBadge />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-3 rounded-lg bg-input px-4">
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
            aria-label={`Message ${channel}`}
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
      </div>
    </div>
  );
}
