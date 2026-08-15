import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Attachment, BoardItem, ChatMessage, Participant } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import type { LocalMessage } from "../hooks/useChatMessages";
import type { ActiveRun } from "../hooks/useAgentTraces";
import type { Typist } from "../hooks/useTyping";
import type { BoardLine } from "../hooks/useBoard";
import { formatDivider, formatShortTime, formatTimestamp } from "../lib/format";
import { buildMentionRegex, escapeRegex, renderContent, renderMessageContent } from "../lib/markdown";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { AttachmentGallery } from "./AttachmentGallery";
import { AttachmentLightbox } from "./AttachmentLightbox";
import { MemberCard } from "./MemberCard";
import { PinIcon, PinnedMessages } from "./PinnedMessages";
import { TraceMessageFinished, TraceMessageLive } from "./TraceMessage";

function mentionsName(content: string, name: string | null): boolean {
  if (!name) return false;
  const regex = new RegExp(`@${escapeRegex(name)}(?![\\w-])`);
  return regex.test(content);
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** Distance from the bottom (px) still counted as "at the bottom" for auto-scroll. */
const NEAR_BOTTOM_PX = 80;
/** Distance from the top (px) that triggers loading older history. */
const NEAR_TOP_PX = 100;
/** Hardcoded quick-react set — no picker dependency, just the common ones. */
const EMOJI_SET = ["👍", "❤️", "😂", "🎉", "👀", "🚀", "😢", "🙏"];

function dayKey(ts: number): string {
  return new Date(ts).toDateString();
}

interface Rendered {
  message: LocalMessage;
  grouped: boolean; // continuation of previous author within window
  newDay: boolean;
}

function layout(messages: LocalMessage[]): Rendered[] {
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
  | { kind: "board"; line: BoardLine }
  | { kind: "trace"; run: ActiveRun };

function timelineTs(entry: TimelineEntry): number {
  if (entry.kind === "message") return entry.message.timestamp;
  if (entry.kind === "board") return entry.line.ts;
  return entry.run.startedAt;
}

function typingLabel(typists: Typist[]): string | null {
  if (typists.length === 0) return null;
  if (typists.length === 1) return `${typists[0].name} is typing…`;
  if (typists.length === 2) return `${typists[0].name} and ${typists[1].name} are typing…`;
  return "Several people are typing…";
}

/** Row of the shared quick-react emoji, reused by the hover picker and the context menu. */
function EmojiRow({ onPick, size = "text-lg" }: { onPick: (emoji: string) => void; size?: string }) {
  return (
    <>
      {EMOJI_SET.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onPick(emoji)}
          className={`rounded-md p-1 ${size} hover:bg-subtle-hover`}
        >
          {emoji}
        </button>
      ))}
    </>
  );
}

function SmileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14c.7 1.2 2 2 3.5 2s2.8-.8 3.5-2" />
      <path d="M9 9h.01M15 9h.01" />
    </svg>
  );
}

function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 17l-5-5 5-5" />
      <path d="M4 12h10a5 5 0 0 1 5 5v2" />
    </svg>
  );
}

function EditIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  );
}

function RailButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center text-muted hover:text-body ${danger ? "hover:text-dead" : ""}`}
    >
      {children}
    </button>
  );
}

/** Inline hover rail, anchored top-right of the message row (replaces the old lone pin button). */
function HoverRail({
  own,
  pinned,
  deleteArmed,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onPin,
}: {
  own: boolean;
  pinned: boolean;
  deleteArmed: boolean;
  onReact: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
}) {
  return (
    <div className="elevated absolute -top-3 right-4 hidden overflow-hidden rounded-md group-hover:flex">
      <RailButton title="Add reaction" onClick={onReact}>
        <SmileIcon className="h-4 w-4" />
      </RailButton>
      <RailButton title="Reply" onClick={onReply}>
        <ReplyIcon className="h-4 w-4" />
      </RailButton>
      {own && (
        <RailButton title="Edit" onClick={onEdit}>
          <EditIcon className="h-4 w-4" />
        </RailButton>
      )}
      {own && (
        <RailButton title={deleteArmed ? "Confirm delete?" : "Delete"} danger onClick={onDelete}>
          <TrashIcon className={`h-4 w-4 ${deleteArmed ? "text-dead" : ""}`} />
        </RailButton>
      )}
      <RailButton title={pinned ? "Unpin message" : "Pin message"} onClick={onPin}>
        <PinIcon className={`h-3.5 w-3.5 ${pinned ? "text-accent" : ""}`} />
      </RailButton>
    </div>
  );
}

/** Small popover of the quick-react set, opened from the hover rail's react button. */
function ReactionEmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="elevated absolute top-6 right-4 z-30 flex gap-0.5 rounded-lg p-1.5"
    >
      <EmojiRow onPick={onPick} />
    </div>
  );
}

function MessageMenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-subtle-hover ${danger ? "text-dead" : "text-body"}`}
    >
      {label}
    </button>
  );
}

/** Right-click menu: same actions as the hover rail, positioned at the cursor. */
function MessageContextMenu({
  x,
  y,
  own,
  pinned,
  confirmingDelete,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onClose,
}: {
  x: number;
  y: number;
  own: boolean;
  pinned: boolean;
  confirmingDelete: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  // Clamp into the viewport once we know the menu's real size (jsdom reports 0
  // for offsetWidth/Height, so tests just see the raw cursor position).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      top: Math.min(y, window.innerHeight - el.offsetHeight - 8),
      left: Math.min(x, window.innerWidth - el.offsetWidth - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ top: pos.top, left: pos.left }}
      className="elevated fixed z-50 w-52 rounded-lg p-1"
    >
      <div className="flex gap-0.5 border-b border-divider p-1.5">
        <EmojiRow
          size="text-base"
          onPick={(emoji) => {
            onReact(emoji);
            onClose();
          }}
        />
      </div>
      <div className="p-1">
        <MessageMenuItem
          label="Reply"
          onClick={() => {
            onReply();
            onClose();
          }}
        />
        {own && (
          <MessageMenuItem
            label="Edit"
            onClick={() => {
              onEdit();
              onClose();
            }}
          />
        )}
        {own && (
          <MessageMenuItem
            label={confirmingDelete ? "Confirm delete?" : "Delete"}
            danger
            onClick={() => {
              onDelete();
              if (confirmingDelete) onClose();
            }}
          />
        )}
        <MessageMenuItem
          label={pinned ? "Unpin" : "Pin"}
          onClick={() => {
            onPin();
            onClose();
          }}
        />
      </div>
    </div>
  );
}

/** Compact preview of the message being replied to; jumps to it on click. */
function ReplyPreview({
  replyToId,
  messages,
  onJump,
}: {
  replyToId: string;
  messages: LocalMessage[];
  onJump: (messageId: string) => void;
}) {
  const original = messages.find((m) => m.id === replyToId);
  if (!original) {
    return <div className="mb-0.5 pl-1 text-xs text-faint">Original message not loaded</div>;
  }
  return (
    <button
      onClick={() => onJump(original.id)}
      className="mb-0.5 flex max-w-full items-center gap-1.5 pl-1 text-left text-xs text-faint hover:text-muted"
    >
      <ReplyIcon className="h-3 w-3 shrink-0 -scale-x-100" />
      <Avatar name={original.authorName} size={14} />
      <span className="shrink-0 font-medium text-muted">{original.authorName}</span>
      <span className="truncate">{original.content || `${original.attachments?.length ?? 0} attachment(s)`}</span>
    </button>
  );
}

/** Enter saves, Shift+Enter newlines, Escape cancels — both clear editingId via the caller. */
function InlineEditor({
  content,
  onSave,
  onCancel,
}: {
  content: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(content);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const trimmed = value.trim();
          if (trimmed) onSave(trimmed);
          else onCancel();
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
      rows={2}
      className="text-input-no-focus-ring w-full resize-none rounded-md bg-subtle px-2 py-1.5 text-[15px] text-body outline-none"
    />
  );
}

/** One pill per emoji, count + highlighted when self reacted; click toggles add/remove. */
function ReactionsRow({
  message,
  selfId,
  onToggle,
}: {
  message: ChatMessage;
  selfId: string | null;
  onToggle: (emoji: string, op: "add" | "remove") => void;
}) {
  if (!message.reactions || message.reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {message.reactions.map((r) => {
        const mine = selfId != null && r.actors.some((a) => a.id === selfId);
        return (
          <button
            key={r.emoji}
            title={r.actors.map((a) => a.name).join(", ")}
            onClick={() => onToggle(r.emoji, mine ? "remove" : "add")}
            className={`rounded-full border px-1.5 py-0.5 text-xs transition ${
              mine
                ? "border-accent/40 bg-accent/10 font-medium text-accent"
                : "border-divider bg-subtle text-muted hover:bg-subtle-hover"
            }`}
          >
            {r.emoji} {r.actors.length}
          </button>
        );
      })}
    </div>
  );
}

function FailedActions({
  nonce,
  onRetry,
  onDiscard,
}: {
  nonce: string;
  onRetry: (nonce: string) => void;
  onDiscard: (nonce: string) => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2 text-xs">
      <span className="text-dead">Failed to send</span>
      <button onClick={() => onRetry(nonce)} className="font-semibold text-accent hover:underline">
        Retry
      </button>
      <button onClick={() => onDiscard(nonce)} className="font-semibold text-muted hover:underline">
        Delete
      </button>
    </div>
  );
}

function TypingRow({ typists }: { typists: Typist[] }) {
  const label = typingLabel(typists);
  if (!label) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-xs text-muted italic">
      <span className="flex gap-0.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-faint [animation-delay:-0.2s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-faint [animation-delay:-0.1s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-faint" />
      </span>
      {label}
    </div>
  );
}

export function MessageList({
  channel,
  onRefClick,
  onReply,
  editingId,
  onEditingIdChange,
  onDiscuss,
  onPrefill,
}: {
  // TODO(channels): channel handling is bolted on (per-message string field,
  // client-side filtering). Needs a proper channel model: scoped
  // history/traces, per-channel reads.
  channel: string;
  onRefClick: (ref: string) => void;
  onReply: (message: ChatMessage) => void;
  editingId: string | null;
  onEditingIdChange: (id: string | null) => void;
  onDiscuss: (item: BoardItem) => void;
  onPrefill: (text: string) => void;
}) {
  const {
    messages: allMessages,
    boardLines,
    activeRuns,
    runDurations,
    participants,
    self,
    pinMessage,
    editMessage,
    deleteMessage,
    reactToMessage,
    retryMessage,
    discardMessage,
    typistsIn,
    firstUnreadId,
    markRead,
    loadOlder,
    pendingInteractions,
    resolveInteraction,
  } = useWorkspace();
  const selfName = self?.name ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  // Bottom-stickiness lives in a ref, not state: it must be readable inside a
  // layout effect without forcing that effect to depend on (and re-run for)
  // every scroll tick.
  const atBottomRef = useRef(true);
  const lastIdRef = useRef<string | null>(null);
  const prevChannelRef = useRef(channel);
  const prependingRef = useRef<{ height: number; top: number; count: number } | null>(null);
  const [newSinceScroll, setNewSinceScroll] = useState(0);

  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // The image currently enlarged; one lightbox serves the whole list.
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  // The message briefly flashed after a jump (reply preview, pinned panel).
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const [reactPickerFor, setReactPickerFor] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const deleteTimerRef = useRef<number | null>(null);
  const [selectedMember, setSelectedMember] = useState<{ participant: Participant; anchor: DOMRect } | null>(null);

  useEffect(
    () => () => {
      if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current);
      if (deleteTimerRef.current != null) window.clearTimeout(deleteTimerRef.current);
    },
    [],
  );

  // Fresh channel: no history-boundary state, no leftover armed menus.
  useEffect(() => {
    setHasMore(true);
    setLoadingOlder(false);
    prependingRef.current = null;
    setConfirmDeleteId(null);
    setReactPickerFor(null);
    setContextMenu(null);
    setSelectedMember(null);
  }, [channel]);

  const jumpToMessage = (messageId: string) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(messageId);
    if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), 2000);
  };

  const pinnedIndicator = (m: ChatMessage) =>
    m.pinnedAt != null && (
      <span className="flex items-center gap-1 text-xs text-faint">
        <PinIcon className="h-3 w-3" />
        Pinned by {m.pinnedBy}
      </span>
    );

  const messages = useMemo(
    () => allMessages.filter((m) => (m.channel ?? "general") === channel),
    [allMessages, channel],
  );

  const mentionRegex = useMemo(
    () => buildMentionRegex(participants.map((p) => p.name)),
    [participants],
  );

  const firstUnread = firstUnreadId(channel);
  const typists = typistsIn(channel);

  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [
      ...layout(messages).map((r) => ({ kind: "message" as const, ...r })),
      ...boardLines.map((line) => ({ kind: "board" as const, line })),
      ...activeRuns.map((run) => ({ kind: "trace" as const, run })),
    ];
    // Stable sort: board lines and live traces interleave with messages by
    // when they started, not appended after the fact.
    return entries.sort((a, b) => timelineTs(a) - timelineTs(b));
  }, [messages, boardLines, activeRuns]);

  // Scroll model: stick to the bottom only while already there; otherwise
  // leave the view alone and surface a "N new messages" pill. Prepending
  // older history restores the exact pre-load offset instead of jumping.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (prevChannelRef.current !== channel) {
      prevChannelRef.current = channel;
      lastIdRef.current = messages[messages.length - 1]?.id ?? null;
      atBottomRef.current = true;
      setNewSinceScroll(0);
      el.scrollTop = el.scrollHeight;
      markRead(channel);
      return;
    }

    if (prependingRef.current) {
      const { height: prevHeight, top: prevTop, count: prevCount } = prependingRef.current;
      prependingRef.current = null;
      // loadOlder can resolve true yet prepend nothing (every message in the
      // fetched page was already loaded, so the de-duplicating prepend
      // leaves the array untouched and this effect doesn't even run for
      // that non-update) — only trust the saved offset when the message
      // count actually grew, otherwise fall through to the normal-tail
      // check below instead of yanking the scroll to a stale offset.
      if (messages.length > prevCount) {
        el.scrollTop = el.scrollHeight - prevHeight + prevTop;
        return;
      }
    }

    const last = messages[messages.length - 1];
    const isNewTail = !!last && last.id !== lastIdRef.current;
    lastIdRef.current = last?.id ?? null;
    if (!isNewTail) return;

    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      markRead(channel);
    } else {
      setNewSinceScroll((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads atBottomRef/lastIdRef by design
  }, [channel, messages]);

  const maybeLoadOlder = (el: HTMLDivElement) => {
    if (loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    prependingRef.current = { height: el.scrollHeight, top: el.scrollTop, count: messages.length };
    void loadOlder(channel).then((more) => {
      setHasMore(more);
      setLoadingOlder(false);
      // Belt-and-suspenders: a no-op prepend (page fully deduped) never
      // changes `messages`, so the layout effect above may never run to
      // consume/clear the ref itself. Clear it here regardless of outcome
      // so a later unrelated render can't misread it as a pending prepend.
      prependingRef.current = null;
    });
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      if (nearBottom) {
        setNewSinceScroll(0);
        markRead(channel);
      }
    }
    if (el.scrollTop <= NEAR_TOP_PX) maybeLoadOlder(el);
  };

  const jumpToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setNewSinceScroll(0);
    markRead(channel);
  };

  const handleDeleteClick = (id: string) => {
    if (confirmDeleteId === id) {
      if (deleteTimerRef.current != null) window.clearTimeout(deleteTimerRef.current);
      setConfirmDeleteId(null);
      deleteMessage(id);
      return;
    }
    if (deleteTimerRef.current != null) window.clearTimeout(deleteTimerRef.current);
    setConfirmDeleteId(id);
    deleteTimerRef.current = window.setTimeout(() => setConfirmDeleteId(null), 3000);
  };

  const openMemberCard = (authorId: string, anchor: DOMRect) => {
    const participant = participants.find((p) => p.id === authorId);
    if (!participant) return;
    setSelectedMember({ participant, anchor });
  };

  /** Header line of an ungrouped message: clickable only for participants still present. */
  const AuthorHeader = ({ m }: { m: LocalMessage }) => {
    const participant = participants.find((p) => p.id === m.authorId);
    return (
      <div className="flex items-baseline gap-2">
        {participant ? (
          <button
            onClick={(e) => openMemberCard(m.authorId, e.currentTarget.getBoundingClientRect())}
            className="font-semibold text-body hover:underline"
          >
            {m.authorName}
          </button>
        ) : (
          <span className="font-semibold text-body">{m.authorName}</span>
        )}
        {m.authorKind === "agent" && <AgentBadge />}
        <span className="font-mono text-[11px] text-faint">{formatTimestamp(m.timestamp)}</span>
        {m.editedAt != null && <span className="text-[10px] text-faint">(edited)</span>}
        {pinnedIndicator(m)}
      </div>
    );
  };

  const AuthorAvatar = ({ m }: { m: LocalMessage }) => {
    const participant = participants.find((p) => p.id === m.authorId);
    if (!participant) return <Avatar name={m.authorName} size={40} />;
    return (
      <button onClick={(e) => openMemberCard(m.authorId, e.currentTarget.getBoundingClientRect())}>
        <Avatar name={m.authorName} size={40} />
      </button>
    );
  };

  const rowClasses = (m: LocalMessage, base: string): string => {
    if (m.failed) return `${base} border-l-2 border-dead bg-subtle pl-[14px] hover:bg-subtle-hover`;
    if (mentionsName(m.content, selfName)) {
      return `${base} border-l-2 border-accent bg-subtle pl-[14px] hover:bg-subtle-hover`;
    }
    return `${base} hover:bg-chat-hover`;
  };

  const messageBody = (m: LocalMessage) =>
    editingId === m.id ? (
      <InlineEditor
        content={m.content}
        onSave={(content) => {
          editMessage(m.id, content);
          onEditingIdChange(null);
        }}
        onCancel={() => onEditingIdChange(null)}
      />
    ) : (
      m.content && (
        <div className="leading-[1.375rem] break-words whitespace-pre-wrap">
          {renderMessageContent(m.content, mentionRegex, onRefClick)}
        </div>
      )
    );

  const messageExtras = (m: LocalMessage) => (
    <>
      {m.attachments && m.attachments.length > 0 && (
        <AttachmentGallery attachments={m.attachments} onImageClick={setLightbox} />
      )}
      <ReactionsRow message={m} selfId={self?.id ?? null} onToggle={(emoji, op) => reactToMessage(m.id, emoji, op)} />
      {m.failed && m.nonce && <FailedActions nonce={m.nonce} onRetry={retryMessage} onDiscard={discardMessage} />}
    </>
  );

  const actionOverlay = (m: LocalMessage) =>
    !m.failed &&
    !m.pending && (
      <>
        <HoverRail
          own={m.authorId === self?.id}
          pinned={m.pinnedAt != null}
          deleteArmed={confirmDeleteId === m.id}
          onReact={() => setReactPickerFor((cur) => (cur === m.id ? null : m.id))}
          onReply={() => onReply(m)}
          onEdit={() => onEditingIdChange(m.id)}
          onDelete={() => handleDeleteClick(m.id)}
          onPin={() => pinMessage(m.id, m.pinnedAt == null)}
        />
        {reactPickerFor === m.id && (
          <ReactionEmojiPicker
            onPick={(emoji) => {
              reactToMessage(m.id, emoji, "add");
              setReactPickerFor(null);
            }}
            onClose={() => setReactPickerFor(null)}
          />
        )}
      </>
    );

  const openContextMenu = (e: React.MouseEvent, messageId: string) => {
    e.preventDefault();
    setReactPickerFor(null);
    setContextMenu({ messageId, x: e.clientX, y: e.clientY });
  };

  const contextMenuMessage = contextMenu ? messages.find((m) => m.id === contextMenu.messageId) : undefined;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-testid="message-scroll"
        className="min-h-0 flex-1 overflow-y-auto pb-4"
      >
        <PinnedMessages messages={messages} onJump={jumpToMessage} />
        {loadingOlder && (
          <div className="py-3 text-center text-xs text-faint">Loading messages…</div>
        )}
        {!hasMore && !loadingOlder && messages.length > 0 && (
          <div className="py-3 text-center font-mono text-[10px] tracking-wider text-faint uppercase">
            Beginning of #{channel}
          </div>
        )}
        {messages.length === 0 && activeRuns.length === 0 && (
          <div className="px-4 pt-12">
            <h2 className="text-3xl font-bold tracking-tight text-body">
              <span className="text-accent">#</span>
              {channel}
            </h2>
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
              <div key={entry.line.id} className="flex justify-center px-4 py-0.5 font-mono text-[11px] text-faint">
                <span>· {renderContent(entry.line.text, null, true, onRefClick)}</span>
              </div>
            );
          }
          if (entry.kind === "trace") {
            return (
              <TraceMessageLive
                key={entry.run.runId}
                runId={entry.run.runId}
                agentName={entry.run.agentName}
                chunks={entry.run.chunks}
                startedAt={entry.run.startedAt}
                interactions={pendingInteractions.filter(
                  (request) => request.agentId === entry.run.agentId,
                )}
                onResolveInteraction={resolveInteraction}
              />
            );
          }
          const { message: m, grouped, newDay } = entry;
          return (
            <div
              key={m.id}
              id={`msg-${m.id}`}
              className={`transition ${highlightId === m.id ? "bg-accent/20" : ""} ${m.pending ? "opacity-50" : ""}`}
            >
              {firstUnread === m.id && (
                <div className="mx-4 my-2 flex items-center gap-3">
                  <span className="font-mono text-[10px] font-bold tracking-wider text-accent uppercase">New</span>
                  <div className="h-px flex-1 bg-accent/40" />
                </div>
              )}
              {newDay && (
                <div className="mx-4 mt-4 mb-1 flex items-center gap-3">
                  <span className="font-mono text-[10px] font-bold tracking-wider text-muted uppercase">{formatDivider(m.timestamp)}</span>
                  <div className="h-px flex-1 bg-divider" />
                </div>
              )}
              {grouped ? (
                <div
                  className={rowClasses(m, "group relative flex gap-4 py-0.5 pr-4 pl-4")}
                  onContextMenu={(e) => openContextMenu(e, m.id)}
                >
                  <div className="w-10 shrink-0 pt-1 text-right font-mono text-[10px] text-faint opacity-0 group-hover:opacity-100">
                    {formatShortTime(m.timestamp)}
                  </div>
                  <div className="min-w-0 flex-1">
                    {m.replyToId && <ReplyPreview replyToId={m.replyToId} messages={messages} onJump={jumpToMessage} />}
                    {messageBody(m)}
                    {messageExtras(m)}
                  </div>
                  {actionOverlay(m)}
                </div>
              ) : (
                <div
                  className={rowClasses(m, "group relative mt-4 flex gap-4 py-0.5 pr-4 pl-4")}
                  onContextMenu={(e) => openContextMenu(e, m.id)}
                >
                  <div className="pt-0.5">
                    <AuthorAvatar m={m} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <AuthorHeader m={m} />
                    {m.replyToId && <ReplyPreview replyToId={m.replyToId} messages={messages} onJump={jumpToMessage} />}
                    {m.trace ? (
                      <TraceMessageFinished message={m} durationMs={runDurations.get(m.runId ?? "")} />
                    ) : (
                      messageBody(m)
                    )}
                    {messageExtras(m)}
                  </div>
                  {actionOverlay(m)}
                </div>
              )}
            </div>
          );
        })}
        <TypingRow typists={typists} />
        {lightbox && (
          <AttachmentLightbox
            attachment={lightbox}
            siblings={messages.find((m) => m.attachments?.some((a) => a.id === lightbox.id))?.attachments}
            onClose={() => setLightbox(null)}
          />
        )}
      </div>
      {newSinceScroll > 0 && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent shadow-lg transition hover:bg-accent-hover"
        >
          {newSinceScroll} new message{newSinceScroll === 1 ? "" : "s"} ↓
        </button>
      )}
      {contextMenu && contextMenuMessage && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          own={contextMenuMessage.authorId === self?.id}
          pinned={contextMenuMessage.pinnedAt != null}
          confirmingDelete={confirmDeleteId === contextMenuMessage.id}
          onReact={(emoji) => reactToMessage(contextMenuMessage.id, emoji, "add")}
          onReply={() => onReply(contextMenuMessage)}
          onEdit={() => onEditingIdChange(contextMenuMessage.id)}
          onDelete={() => handleDeleteClick(contextMenuMessage.id)}
          onPin={() => pinMessage(contextMenuMessage.id, contextMenuMessage.pinnedAt == null)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {selectedMember && (
        <MemberCard
          participant={selectedMember.participant}
          channel={channel}
          anchor={selectedMember.anchor}
          onDiscuss={onDiscuss}
          onPrefill={onPrefill}
          onClose={() => setSelectedMember(null)}
        />
      )}
    </div>
  );
}
