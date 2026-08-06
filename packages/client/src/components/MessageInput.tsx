import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Participant } from "@workspace/shared";
import { buildMentionRegex, renderContent } from "../lib/markdown";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { useMessageDrafts } from "../hooks/useMessageDrafts";
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

const MAX_LENGTH = 4000;
const COUNTER_AT = 200;

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
  /** Returns true when the content was consumed (sent or a valid command). */
  onSend: (content: string, attachmentIds: string[]) => boolean;
  prefill?: Prefill | null;
}) {
  const {
    participants,
    attachmentDraftsFor,
    addAttachments,
    removeAttachment,
    takeReadyAttachmentIds,
  } = useWorkspace();
  const { draft, setDraft, clearDraft } = useMessageDrafts(channel);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const attachments = attachmentDraftsFor(channel);
  const uploadsInFlight = attachments.some((a) => a.status === "uploading");
  const hasReadyAttachment = attachments.some((a) => a.status === "ready");
  const remaining = MAX_LENGTH - draft.length;

  useEffect(() => {
    if (!prefill) return;
    if (!draft.includes(prefill.text.trim())) {
      const sep = draft && !draft.endsWith(" ") ? " " : "";
      setDraft(draft + sep + prefill.text);
    }
    inputRef.current?.focus();
  }, [prefill]);

  useEffect(() => {
    inputRef.current?.focus();
    setMention(null);
  }, [channel]);

  // Typing anywhere with nothing focused lands the keystroke in the composer.
  useEffect(() => {
    const redirect = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", redirect);
    return () => document.removeEventListener("keydown", redirect);
  }, []);

  // Auto-grow with content; the max-height class caps it and scrolls beyond.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

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
    if (uploadsInFlight) return;
    const trimmed = draft.trim();
    if (!trimmed && !hasReadyAttachment) return;
    // Attachments are only taken when present (they force a message send, so
    // onSend consumes them); a refused command must not eat the tray.
    const ids = hasReadyAttachment ? takeReadyAttachmentIds(channel) : [];
    if (!onSend(trimmed, ids)) return;
    clearDraft();
    setMention(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.nativeEvent.isComposing) return;
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
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
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
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        // Autocomplete, never execute; when the box already holds the
        // highlighted command, Enter falls through and sends it as typed.
        if (e.key === "Tab" || draft !== `/${commandMatches[highlighted].name}`) {
          e.preventDefault();
          pickCommand(commandMatches[highlighted]);
          return;
        }
      }
      if (e.key === "Escape") {
        setCommandDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
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
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 rounded-lg bg-input p-2">
          {attachments.map((a) => (
            <div
              key={a.localId}
              title={a.status === "failed" ? (a.error ?? "Upload failed") : a.name}
              className={`relative h-16 shrink-0 overflow-hidden rounded-md bg-popup ${
                a.previewUrl ? "w-16" : "max-w-48"
              } ${a.status === "uploading" ? "opacity-60" : ""} ${
                a.status === "failed" ? "ring-2 ring-dead" : ""
              }`}
            >
              {a.previewUrl ? (
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center gap-1.5 px-2 pr-6">
                  <svg
                    className="h-5 w-5 shrink-0 text-muted"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <path d="M14 2v6h6" stroke="currentColor" strokeWidth="2" />
                  </svg>
                  <span className="truncate text-xs text-muted">{a.name}</span>
                </div>
              )}
              {a.status === "uploading" && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg
                    className="h-5 w-5 animate-spin text-body"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="opacity-25"
                    />
                    <path
                      d="M12 2a10 10 0 0 1 10 10"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              )}
              <button
                onClick={() => removeAttachment(channel, a.localId)}
                aria-label={`Remove ${a.name}`}
                className="absolute top-0.5 right-0.5 rounded bg-sidebar-dark/80 p-0.5 text-muted hover:text-body"
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="relative flex items-end gap-3 rounded-lg bg-input px-4">
        <input
          ref={fileRef}
          type="file"
          multiple
          aria-label="Choose files to attach"
          className="hidden"
          onChange={(e) => {
            addAttachments(channel, Array.from(e.target.files ?? []));
            // Reset so picking the same file again re-fires onChange.
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          aria-label="Attach files"
          title="Attach files"
          className="mb-2.5 shrink-0 rounded p-0.5 text-muted hover:text-body"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
            <path
              d="M12 8v8M8 12h8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div className="relative min-w-0 flex-1">
          <div
            ref={displayRef}
            className="pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap py-2.5 text-body"
          >
            {!draft && <span className="text-faint">{`Message #${channel}`}</span>}
            {draft && renderContent(draft, mentionRegex, false)}
            {/* pre-wrap drops a trailing newline the textarea still shows */}
            {draft.endsWith("\n") && "\u200b"}
          </div>
          <textarea
            ref={inputRef}
            rows={1}
            aria-label={`Message ${channel}`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length === 0) return;
              e.preventDefault();
              addAttachments(channel, files);
            }}
            onBlur={() => setMention(null)}
            onScroll={(e) => {
              if (displayRef.current) {
                displayRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            className="relative block max-h-[40vh] w-full resize-none overflow-y-auto break-words bg-transparent py-2.5 text-transparent outline-none"
            style={{ caretColor: "var(--color-body)" }}
            placeholder=""
            maxLength={MAX_LENGTH}
          />
        </div>
        {remaining <= COUNTER_AT && (
          <span
            className={`pointer-events-none absolute right-2 bottom-1 text-xs ${
              remaining < 50 ? "text-dead" : "text-muted"
            }`}
          >
            {remaining}
          </span>
        )}
      </div>
    </div>
  );
}
