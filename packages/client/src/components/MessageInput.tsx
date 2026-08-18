import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Participant } from "@workspace/shared";
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

interface EmojiQuery {
  start: number; // index of the ':' in the draft
  query: string;
}

interface SlashCommand {
  name: string;
  description: string;
}

const MAX_LENGTH = 4000;
const COUNTER_AT = 200;
const REPLY_PREVIEW_LENGTH = 120;

const COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Clear all messages in the channel" },
  { name: "interrupt", description: "Interrupt an agent and redirect it: /interrupt @agent new prompt" },
];

// Small hardcoded set (no emoji-dataset dependency): the grid picker just
// shows every value; the map also backs `:shortcode:` autocomplete.
const EMOJI_SHORTCODES: Record<string, string> = {
  smile: "😀",
  laughing: "😂",
  rofl: "🤣",
  blush: "😊",
  heart_eyes: "😍",
  kiss: "😘",
  wink: "😜",
  thinking: "🤔",
  sunglasses: "😎",
  cry: "😢",
  sob: "😭",
  rage: "😡",
  party: "🥳",
  sleeping: "😴",
  mindblown: "🤯",
  eyeroll: "🙄",
  innocent: "😇",
  hugs: "🤗",
  love: "🥰",
  smirk: "😏",
  thumbsup: "👍",
  thumbsdown: "👎",
  clap: "👏",
  raised_hands: "🙌",
  pray: "🙏",
  muscle: "💪",
  fire: "🔥",
  hundred: "💯",
  tada: "🎉",
  heart: "❤️",
  broken_heart: "💔",
  star: "⭐",
  check: "✅",
  cross: "❌",
  warning: "⚠️",
  rocket: "🚀",
  eyes: "👀",
  handshake: "🤝",
  sweat_smile: "😅",
  facepalm: "🤦",
  wave: "👋",
};
const EMOJI_GRID = Object.values(EMOJI_SHORTCODES);

// Highlighted row in the autocomplete popups. `bg-input` matches `--color-popup`
// in light mode, so the selection was invisible there; tint with the accent
// instead, which reads in both themes.
const SELECTED = "bg-accent/15 text-body";

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

function findEmojiQuery(text: string, caret: number): EmojiQuery | null {
  const upToCaret = text.slice(0, caret);
  const colon = upToCaret.lastIndexOf(":");
  if (colon === -1) return null;
  // ':' must be at the start or preceded by whitespace, same rule as '@',
  // so times ("3:30") and URLs don't get misread as shortcode queries.
  if (colon > 0 && !/\s/.test(upToCaret[colon - 1])) return null;
  const query = upToCaret.slice(colon + 1);
  if (!/^[a-z0-9_+-]*$/i.test(query)) return null;
  return { start: colon, query };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function MessageInput({
  channel,
  onSend,
  prefill,
  replyTo,
  onCancelReply,
  editingId,
  onRequestEditLast,
}: {
  channel: string;
  /** Returns true when the content was consumed (sent or a valid command). */
  onSend: (content: string, attachmentIds: string[]) => boolean;
  prefill?: Prefill | null;
  /** Message being replied to; App owns this, MessageInput only displays/cancels it. */
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  /** Id of the message MessageList is currently inline-editing, if any. */
  editingId: string | null;
  /** Requests MessageList open its inline editor for the given message id. */
  onRequestEditLast: (id: string) => void;
}) {
  const {
    workspaceId,
    participants,
    messages,
    self,
    attachmentDraftsFor,
    addAttachments,
    removeAttachment,
    takeReadyAttachmentIds,
    sendTyping,
  } = useWorkspace();
  const { draft, setDraft, clearDraft } = useMessageDrafts(workspaceId, channel);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [emojiQuery, setEmojiQuery] = useState<EmojiQuery | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const emojiPopupRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

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
    setEmojiQuery(null);
    setEmojiPickerOpen(false);
  }, [channel]);

  // A reply target was just picked (from MessageList): bring the caret back.
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo?.id]);

  // Click/Escape outside the emoji grid closes it; it's opened by a button,
  // not the textarea, so it needs its own dismissal path.
  useEffect(() => {
    if (!emojiPickerOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (emojiPopupRef.current?.contains(e.target as Node)) return;
      if (emojiButtonRef.current?.contains(e.target as Node)) return;
      setEmojiPickerOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEmojiPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [emojiPickerOpen]);

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

  const shortcodeMatches = emojiQuery
    ? Object.entries(EMOJI_SHORTCODES).filter(([name]) =>
        name.startsWith(emojiQuery.query.toLowerCase()),
      )
    : [];
  const shortcodeOpen =
    !mentionOpen && !commandOpen && shortcodeMatches.length > 0;

  // Own most recent message in this channel, skipping optimistic entries
  // whose id is still a placeholder nonce (nothing real to edit yet).
  const lastOwnMessageId = useMemo(() => {
    if (!self) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.pending || m.failed) continue;
      if (m.authorId !== self.id) continue;
      if ((m.channel ?? "general") !== channel) continue;
      return m.id;
    }
    return null;
  }, [messages, self, channel]);

  const updateMention = (value: string, caret: number | null) => {
    setMention(findMentionQuery(value, caret ?? value.length));
    setCommandDismissed(false);
    setHighlighted(0);
  };

  const updateEmojiQuery = (value: string, caret: number | null) => {
    setEmojiQuery(findEmojiQuery(value, caret ?? value.length));
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

  const pickEmojiShortcode = (emoji: string) => {
    if (!emojiQuery) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const next = draft.slice(0, emojiQuery.start) + `${emoji} ` + draft.slice(caret);
    setDraft(next);
    setEmojiQuery(null);
    inputRef.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const start = inputRef.current?.selectionStart ?? draft.length;
    const end = inputRef.current?.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    setEmojiPickerOpen(false);
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
    } else if (shortcodeOpen) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted(
          (h) => (h - 1 + shortcodeMatches.length) % shortcodeMatches.length,
        );
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % shortcodeMatches.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickEmojiShortcode(shortcodeMatches[highlighted][1]);
        return;
      }
      if (e.key === "Escape") {
        setEmojiQuery(null);
        return;
      }
    }
    // Reached only when no autocomplete popup is open (each branch above
    // returns for its own Escape/Enter/arrows).
    if (e.key === "Escape" && replyTo) {
      onCancelReply();
      return;
    }
    if (
      e.key === "ArrowUp" &&
      !editingId &&
      !draft &&
      attachments.length === 0 &&
      lastOwnMessageId
    ) {
      e.preventDefault();
      onRequestEditLast(lastOwnMessageId);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative shrink-0 border-t border-divider px-4 pb-6">
      {commandOpen && (
        <div className="elevated absolute bottom-full left-4 right-4 z-10 mb-2 overflow-hidden rounded-lg">
          <div className="px-3 pt-3 pb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
            Commands
          </div>
          <ul className="max-h-64 overflow-y-auto p-1.5 pt-0">
            {commandMatches.map((c, i) => (
              <li key={c.name}>
                <button
                  className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left ${
                    i === highlighted ? SELECTED : ""
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
        <div className="elevated absolute bottom-full left-4 right-4 z-10 mb-2 overflow-hidden rounded-lg">
          <div className="px-3 pt-3 pb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
            Members
          </div>
          <ul className="max-h-64 overflow-y-auto p-1.5 pt-0">
            {matches.map((p, i) => (
              <li key={p.id}>
                <button
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${
                    i === highlighted ? SELECTED : "text-body"
                  }`}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(p);
                  }}
                >
                  <Avatar name={p.name} size={24} mascot={p.managedAgent === "noodle"} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.kind === "agent" && <AgentBadge />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {shortcodeOpen && (
        <div className="elevated absolute bottom-full left-4 right-4 z-10 mb-2 overflow-hidden rounded-lg">
          <div className="px-3 pt-3 pb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
            Emoji
          </div>
          <ul className="max-h-64 overflow-y-auto p-1.5 pt-0">
            {shortcodeMatches.map(([name, emoji], i) => (
              <li key={name}>
                <button
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${
                    i === highlighted ? SELECTED : ""
                  }`}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickEmojiShortcode(emoji);
                  }}
                >
                  <span className="text-lg">{emoji}</span>
                  <span className="min-w-0 flex-1 truncate text-body">:{name}:</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {emojiPickerOpen && (
        <div
          ref={emojiPopupRef}
          className="elevated absolute bottom-full left-4 z-10 mb-2 grid w-64 grid-cols-8 gap-1 rounded-lg p-2"
        >
          {EMOJI_GRID.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertEmoji(emoji);
              }}
              className="rounded-md p-1 text-lg hover:bg-subtle-hover"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-subtle px-3 py-2">
          <div className="min-w-0 flex-1 border-l-2 border-accent pl-2">
            <div className="text-xs font-semibold text-accent">
              Replying to {replyTo.authorName}
            </div>
            <div className="truncate text-xs text-muted">
              {truncate(replyTo.content, REPLY_PREVIEW_LENGTH)}
            </div>
          </div>
          <button
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="shrink-0 rounded p-1 text-muted hover:text-body"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 rounded-lg bg-subtle p-2">
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
                className="absolute top-0.5 right-0.5 rounded bg-backdrop/80 p-0.5 text-overlay-ink/70 hover:text-overlay-ink"
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
      <div className="relative flex items-end gap-3 pt-1">
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
        <button
          ref={emojiButtonRef}
          onClick={() => setEmojiPickerOpen((open) => !open)}
          aria-label="Insert emoji"
          title="Insert emoji"
          className="mb-2.5 shrink-0 rounded p-0.5 text-muted hover:text-body"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
            <path
              d="M8 14s1.5 2 4 2 4-2 4-2"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path d="M9 9h.01M15 9h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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
              const value = e.target.value;
              setDraft(value);
              updateMention(value, e.target.selectionStart);
              updateEmojiQuery(value, e.target.selectionStart);
              setEmojiPickerOpen(false);
              if (!value.startsWith("/")) sendTyping(channel);
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length === 0) return;
              e.preventDefault();
              addAttachments(channel, files);
            }}
            onBlur={() => {
              setMention(null);
              setEmojiQuery(null);
            }}
            onScroll={(e) => {
              if (displayRef.current) {
                displayRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            className="text-input-no-focus-ring relative block max-h-[40vh] w-full resize-none overflow-y-auto break-words bg-transparent py-2.5 text-transparent outline-none"
            style={{ caretColor: "var(--color-body)" }}
            placeholder=""
            maxLength={MAX_LENGTH}
          />
        </div>
        {remaining <= COUNTER_AT && (
          <span
            className={`pointer-events-none absolute right-2 bottom-1 text-[10px] ${
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
