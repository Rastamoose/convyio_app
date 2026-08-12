import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardItem, Participant } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { presenceDot, presenceLabel } from "../lib/status";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { AddAgentModal } from "./AddAgentModal";
import { ApprovalQueue } from "./ApprovalQueue";
import { MemberCard } from "./MemberCard";
import { PinIcon } from "./PinnedMessages";

/** How long a "Delete" click stays armed before a second click is required. */
const DELETE_CONFIRM_MS = 3000;

function RoomMenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded px-2 py-1.5 text-left text-sm font-medium hover:bg-mention-bg-hover ${danger ? "text-dead" : "text-body"}`}
    >
      {label}
    </button>
  );
}

/** Right-click menu for a room row, positioned at the cursor. */
function RoomContextMenu({
  x,
  y,
  channel,
  pinned,
  archived,
  confirmingDelete,
  onMarkRead,
  onTogglePin,
  onRename,
  onToggleArchive,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  channel: string;
  pinned: boolean;
  archived: boolean;
  confirmingDelete: boolean;
  onMarkRead: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });
  // "general" is the fixed default channel messages fall back to; the server
  // refuses to rename/archive/delete it, so those actions aren't offered.
  const isGeneral = channel === "general";

  // Clamp into the viewport once we know the menu's real size (jsdom reports
  // 0 for offsetWidth/Height, so tests just see the raw cursor position).
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
      aria-label={`Room actions for ${channel}`}
      style={{ top: pos.top, left: pos.left }}
      className="fixed z-50 w-48 rounded-lg border border-divider bg-popup p-1 shadow-lg"
    >
      <RoomMenuItem
        label="Mark as read"
        onClick={() => {
          onMarkRead();
          onClose();
        }}
      />
      <RoomMenuItem
        label={pinned ? "Unpin" : "Pin channel"}
        onClick={() => {
          onTogglePin();
          onClose();
        }}
      />
      {!isGeneral && (
        <RoomMenuItem
          label="Rename"
          onClick={() => {
            onRename();
            onClose();
          }}
        />
      )}
      {!isGeneral && (
        <RoomMenuItem
          label={archived ? "Unarchive" : "Archive"}
          onClick={() => {
            onToggleArchive();
            onClose();
          }}
        />
      )}
      {!isGeneral && (
        <RoomMenuItem
          label={confirmingDelete ? "Confirm delete?" : "Delete"}
          danger
          onClick={() => {
            onDelete();
            if (confirmingDelete) onClose();
          }}
        />
      )}
    </div>
  );
}

function PresenceDot({ participant }: { participant: Participant }) {
  const { color, pulse } = presenceDot(participant);
  const label = presenceLabel(participant);
  if (!pulse) {
    return (
      <span
        title={label}
        className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-[2.5px] border-sidebar transition-colors duration-200 ${color}`}
      />
    );
  }
  return (
    <span
      title={label}
      className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full border-[2.5px] border-sidebar bg-sidebar"
    >
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 transition-colors duration-200 ${color}`}
      />
      <span
        className={`relative inline-flex h-1.5 w-1.5 rounded-full transition-colors duration-200 ${color}`}
      />
    </span>
  );
}

function StatusRow({
  participant,
  onSelect,
}: {
  participant: Participant;
  onSelect: (participant: Participant, anchor: DOMRect) => void;
}) {
  const isAgent = participant.kind === "agent";
  const working = isAgent && participant.runState === "working";
  const blocked = isAgent && participant.runState === "blocked";
  const dead = isAgent && participant.runState === "dead";
  const offline = !participant.online;
  return (
    <div
      className={`flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 select-none hover:bg-black/5 ${
        offline ? "opacity-40 hover:opacity-100" : ""
      }`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => onSelect(participant, e.currentTarget.getBoundingClientRect())}
    >
      <div className="relative">
        <Avatar name={participant.name} size={32} grayscale={offline} />
        <PresenceDot participant={participant} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-body">
          {participant.name}
          {isAgent && <AgentBadge className="ml-1.5 align-middle" />}
        </div>
        <div
          className={`truncate text-xs ${
            working
              ? "font-medium text-working"
              : blocked || dead
                ? "font-medium text-dead"
                : "text-muted"
          }`}
        >
          {dead
            ? `Dead${participant.status ? ` — ${participant.status}` : ""}`
            : blocked
              ? participant.status || "Blocked — waiting on a human"
              : participant.status ||
                (participant.online ? "Online" : "Offline")}
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  channel,
  onSelectChannel,
  onDiscuss,
  onPrefill,
}: {
  channel: string;
  onSelectChannel: (channel: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onPrefill: (text: string) => void;
}) {
  const {
    workspace,
    participants,
    self,
    channels,
    archivedChannels,
    pinnedChannels,
    board,
    setStatus,
    signOut,
    createChannel,
    renameChannel,
    archiveChannel,
    pinChannel,
    deleteChannel,
    unreadCount,
    markRead,
  } = useWorkspace();
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [selected, setSelected] = useState<{
    participantId: string;
    anchor: DOMRect;
  } | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [roomDraft, setRoomDraft] = useState("");
  const [roomsOpen, setRoomsOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    channel: string;
    x: number;
    y: number;
  } | null>(null);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [renamingChannel, setRenamingChannel] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteChannel, setConfirmDeleteChannel] = useState<string | null>(null);
  const deleteTimerRef = useRef<number | null>(null);

  // Pinned rooms bubble to the top; otherwise the server's display order holds.
  const sortedChannels = [...channels].sort(
    (a, b) => Number(pinnedChannels.includes(b)) - Number(pinnedChannels.includes(a)),
  );

  const openRoomMenu = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    setContextMenu({ channel: name, x: e.clientX, y: e.clientY });
  };

  const startRename = (name: string) => {
    setRenamingChannel(name);
    setRenameDraft(name);
  };

  const submitRename = async () => {
    const name = renamingChannel;
    const draft = renameDraft.trim();
    setRenamingChannel(null);
    if (!name || !draft || draft === name) return;
    const renamed = await renameChannel(name, draft);
    if (renamed && channel === name) onSelectChannel(renamed);
  };

  const handleDeleteClick = (name: string) => {
    if (confirmDeleteChannel === name) {
      if (deleteTimerRef.current != null) window.clearTimeout(deleteTimerRef.current);
      setConfirmDeleteChannel(null);
      void deleteChannel(name);
      return;
    }
    if (deleteTimerRef.current != null) window.clearTimeout(deleteTimerRef.current);
    setConfirmDeleteChannel(name);
    deleteTimerRef.current = window.setTimeout(
      () => setConfirmDeleteChannel(null),
      DELETE_CONFIRM_MS,
    );
  };

  const renderRoom = (c: string) => {
    if (renamingChannel === c) {
      return (
        <input
          key={c}
          autoFocus
          aria-label={`Rename ${c}`}
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onBlur={() => void submitRename()}
          onKeyDown={(e) => {
            if (e.key === "Escape") setRenamingChannel(null);
            if (e.key === "Enter") void submitRename();
          }}
          maxLength={32}
          className="mb-0.5 w-full rounded-lg bg-input px-2 py-1.5 text-[15px] text-body outline-none placeholder:text-faint"
        />
      );
    }
    const unreads = unreadCount(c);
    return (
      <button
        key={c}
        role="tab"
        aria-selected={c === channel}
        onClick={() => onSelectChannel(c)}
        onContextMenu={(e) => openRoomMenu(e, c)}
        className={`mb-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left font-medium select-none ${
          c === channel || contextMenu?.channel === c
            ? "bg-input text-body"
            : unreads > 0
              ? "text-body hover:bg-input/70"
              : "text-muted hover:bg-input/70 hover:text-body"
        }`}
      >
        <span className="shrink-0 text-[15px] text-faint">#</span>
        <span className="min-w-0 truncate text-[15px]">{c}</span>
        {pinnedChannels.includes(c) && (
          <PinIcon className="ml-auto h-3 w-3 shrink-0 text-faint" />
        )}
        {unreads > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-working px-2 py-0.5 text-[13px] font-semibold text-mention-text">
            {unreads > 99 ? "99+" : unreads}
          </span>
        )}
      </button>
    );
  };

  const byName = (a: Participant, b: Participant) => a.name.localeCompare(b.name);
  const online = participants.filter((p) => p.online).sort(byName);
  const offline = participants.filter((p) => !p.online).sort(byName);
  const pendingItems = board
    .filter((i) => i.status === "proposed")
    .sort((a, b) => b.createdAt - a.createdAt);
  const selectedMember = selected
    ? (participants.find((p) => p.id === selected.participantId) ?? null)
    : null;

  const discuss = (item: BoardItem) => {
    setQueueOpen(false);
    setSelected(null);
    onDiscuss(item);
  };

  const submitRoom = async () => {
    const name = roomDraft.trim();
    if (!name) {
      setCreatingRoom(false);
      return;
    }
    const created = await createChannel(name);
    // On failure the input stays open with the draft; the toast has the error.
    if (created) {
      setCreatingRoom(false);
      setRoomDraft("");
      onSelectChannel(created);
    }
  };

  return (
    <aside className="flex h-full w-60 flex-col bg-sidebar">
      {/* Workspace header */}
      <header className="flex h-12 shrink-0 flex-col justify-center border-b border-sidebar-dark px-4 select-none">
        <span className="truncate font-semibold text-body">{workspace?.name}</span>
        <span className="truncate text-[11px] leading-tight text-faint">
          humans &amp; agents, one room
        </span>
      </header>

      {/* Status area — top third, becomes the status strip */}
      <section className="min-h-0 basis-1/3 overflow-y-auto px-2 pt-3">
        {pendingItems.length > 0 && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setQueueOpen((o) => !o)}
            className="mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-lg bg-dead/20 px-2 py-1.5 text-left text-sm font-semibold text-dead select-none hover:bg-dead/30"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-dead opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-dead" />
            </span>
            Awaiting approval ({pendingItems.length})
          </button>
        )}
        <h2 className="mb-1 px-2 text-[11px] font-bold tracking-wide text-muted uppercase select-none">
          Online — {online.length}
        </h2>
        {online.map((p) => (
          <StatusRow
            key={p.id}
            participant={p}
            onSelect={(m, anchor) => setSelected({ participantId: m.id, anchor })}
          />
        ))}
        {offline.length > 0 && (
          <>
            <h2 className="mt-2 mb-1 px-2 text-[11px] font-bold tracking-wide text-muted uppercase select-none">
              Offline — {offline.length}
            </h2>
            {offline.map((p) => (
              <StatusRow
                key={p.id}
                participant={p}
                onSelect={(m, anchor) => setSelected({ participantId: m.id, anchor })}
              />
            ))}
          </>
        )}
        {self?.kind === "human" && (
          <button
            onClick={() => setAddAgentOpen(true)}
            className="mt-2 flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-dashed border-divider px-2 py-2 text-left text-sm font-medium text-muted hover:border-body hover:text-body select-none"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-dark text-lg font-bold text-muted">
              +
            </span>
            Add agent
          </button>
        )}
      </section>

      {/* Rooms */}
      <section className="min-h-0 flex-1 overflow-y-auto border-t border-divider px-2 pt-3">
        <div className="mb-1 flex items-center justify-between px-2">
          <button
            onClick={() => setRoomsOpen((o) => !o)}
            className="flex cursor-pointer items-center gap-1 text-[11px] font-bold tracking-wide text-muted uppercase select-none hover:text-body"
          >
            <span className="w-2.5 shrink-0">{roomsOpen ? "▾" : "▸"}</span>
            Rooms
          </button>
          <button
            aria-label="Create a room"
            onClick={() => setCreatingRoom(true)}
            className="cursor-pointer rounded px-1 text-sm leading-none text-muted select-none hover:text-body"
          >
            +
          </button>
        </div>
        {creatingRoom && (
          <input
            autoFocus
            aria-label="New room name"
            value={roomDraft}
            onChange={(e) => setRoomDraft(e.target.value)}
            // Blur closes but keeps the draft; Escape closes and discards it.
            onBlur={() => setCreatingRoom(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setRoomDraft("");
                setCreatingRoom(false);
              }
              if (e.key === "Enter") void submitRoom();
            }}
            maxLength={32}
            placeholder="new-room"
            className="mb-0.5 w-full rounded-lg bg-input px-2 py-1.5 text-[15px] text-body outline-none placeholder:text-faint"
          />
        )}
        {roomsOpen && (
          <div role="tablist" aria-label="Rooms">
            {sortedChannels.map(renderRoom)}
          </div>
        )}

        {archivedChannels.length > 0 && (
          <>
            <button
              onClick={() => setArchivedOpen((o) => !o)}
              className="mt-2 mb-1 flex items-center gap-1 px-2 text-[11px] font-bold tracking-wide text-muted uppercase select-none hover:text-body"
            >
              <span className="w-2.5 shrink-0">{archivedOpen ? "▾" : "▸"}</span>
              Archived — {archivedChannels.length}
            </button>
            {archivedOpen && (
              <div role="tablist" aria-label="Archived rooms">
                {archivedChannels.map(renderRoom)}
              </div>
            )}
          </>
        )}
      </section>

      {/* User panel */}
      <footer className="flex h-[52px] shrink-0 items-center gap-2 bg-userpanel px-2">
        {self && (
          <>
            <div className="relative">
              <Avatar name={self.name} size={32} />
              <PresenceDot participant={self} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-body select-none">
                {self.name}
              </div>
              {editingStatus ? (
                <input
                  autoFocus
                  aria-label="Set a status"
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value)}
                  onBlur={() => {
                    setStatus(statusDraft);
                    setEditingStatus(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setStatus(statusDraft);
                      setEditingStatus(false);
                    }
                  }}
                  className="w-full bg-transparent text-xs text-body outline-none"
                  placeholder="Set a status…"
                  maxLength={128}
                />
              ) : (
                <button
                  onClick={() => {
                    setStatusDraft(self.status);
                    setEditingStatus(true);
                  }}
                  className="block w-full cursor-pointer truncate text-left text-xs text-muted select-none hover:text-body"
                >
                  {self.status || "Set a status…"}
                </button>
              )}
            </div>
            {signOut && (
              <button
                onClick={signOut}
                className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-[11px] text-muted select-none hover:bg-black/5 hover:text-body"
              >
                Sign out
              </button>
            )}
          </>
        )}
      </footer>

      {queueOpen && pendingItems.length > 0 && (
        <ApprovalQueue
          items={pendingItems}
          onDiscuss={discuss}
          onClose={() => setQueueOpen(false)}
        />
      )}
      {selectedMember && selected && (
        <MemberCard
          participant={selectedMember}
          anchor={selected.anchor}
          onDiscuss={discuss}
          onPrefill={onPrefill}
          onClose={() => setSelected(null)}
        />
      )}
      {contextMenu && (
        <RoomContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          channel={contextMenu.channel}
          pinned={pinnedChannels.includes(contextMenu.channel)}
          archived={archivedChannels.includes(contextMenu.channel)}
          confirmingDelete={confirmDeleteChannel === contextMenu.channel}
          onMarkRead={() => markRead(contextMenu.channel)}
          onTogglePin={() =>
            void pinChannel(contextMenu.channel, !pinnedChannels.includes(contextMenu.channel))
          }
          onRename={() => startRename(contextMenu.channel)}
          onToggleArchive={() =>
            void archiveChannel(
              contextMenu.channel,
              !archivedChannels.includes(contextMenu.channel),
            )
          }
          onDelete={() => handleDeleteClick(contextMenu.channel)}
          onClose={() => setContextMenu(null)}
        />
      )}
      <AddAgentModal open={addAgentOpen} onClose={() => setAddAgentOpen(false)} />
    </aside>
  );
}
