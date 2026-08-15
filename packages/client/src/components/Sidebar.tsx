import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardItem, Participant } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { presenceDot, presenceLabel } from "../lib/status";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { AddAgentModal } from "./AddAgentModal";
import { MemberCard } from "./MemberCard";
import { PinIcon } from "./PinnedMessages";

/** How long a "Delete" click stays armed before a second click is required. */
const DELETE_CONFIRM_MS = 3000;

function ContextMenuItem({
  label,
  onClick,
  danger,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`block w-full rounded-md px-2 py-1.5 text-left text-sm font-medium ${danger ? "text-dead" : "text-body"} ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-subtle-hover"}`}
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
      className="elevated fixed z-50 w-48 rounded-lg p-1"
    >
      <ContextMenuItem
        label="Mark as read"
        onClick={() => {
          onMarkRead();
          onClose();
        }}
      />
      <ContextMenuItem
        label={pinned ? "Unpin" : "Pin channel"}
        onClick={() => {
          onTogglePin();
          onClose();
        }}
      />
      {!isGeneral && (
        <ContextMenuItem
          label="Rename"
          onClick={() => {
            onRename();
            onClose();
          }}
        />
      )}
      {!isGeneral && (
        <ContextMenuItem
          label={archived ? "Unarchive" : "Archive"}
          onClick={() => {
            onToggleArchive();
            onClose();
          }}
        />
      )}
      {!isGeneral && (
        <ContextMenuItem
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

/** Right-click menu for a member row, positioned at the cursor. */
function MemberContextMenu({
  x,
  y,
  name,
  removable,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  name: string;
  /** Only invite-created agents are removable today; humans and agents
   *  joined with the server-wide token need server-side permissions that
   *  don't exist yet, so for them the action shows as unavailable. */
  removable: boolean;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

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
      aria-label={`Member actions for ${name}`}
      style={{ top: pos.top, left: pos.left }}
      className="elevated fixed z-50 w-48 rounded-lg p-1"
    >
      <ContextMenuItem
        label="Remove"
        danger
        disabled={!removable}
        title={
          removable
            ? undefined
            : "You don't have permission to remove this member"
        }
        onClick={() => {
          onRemove();
          onClose();
        }}
      />
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
        className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-[2.5px] border-canvas transition-colors duration-200 ${color}`}
      />
    );
  }
  return (
    <span
      title={label}
      className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full border-[2.5px] border-canvas bg-canvas"
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
  onContextMenu,
}: {
  participant: Participant;
  onSelect: (participant: Participant, anchor: DOMRect) => void;
  onContextMenu: (participant: Participant, e: React.MouseEvent) => void;
}) {
  const isAgent = participant.kind === "agent";
  const working = isAgent && participant.runState === "working";
  const blocked = isAgent && participant.runState === "blocked";
  const dead = isAgent && participant.runState === "dead";
  const offline = !participant.online;
  return (
    <div
      className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 select-none hover:bg-input ${
        offline ? "opacity-40 hover:opacity-100" : ""
      }`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => onSelect(participant, e.currentTarget.getBoundingClientRect())}
      onContextMenu={(e) => onContextMenu(participant, e)}
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
    participants,
    self,
    channels,
    archivedChannels,
    pinnedChannels,
    setStatus,
    signOut,
    createChannel,
    renameChannel,
    archiveChannel,
    pinChannel,
    deleteChannel,
    unreadCount,
    markRead,
    agentInvites,
    revokeAgent,
    removeMember,
  } = useWorkspace();
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
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
  const [memberMenu, setMemberMenu] = useState<{
    participantId: string;
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

  const openMemberMenu = (participant: Participant, e: React.MouseEvent) => {
    e.preventDefault();
    setMemberMenu({ participantId: participant.id, x: e.clientX, y: e.clientY });
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
          className="mb-0.5 w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
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
        className={`mb-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm select-none ${
          c === channel || contextMenu?.channel === c
            ? "bg-input font-semibold text-body"
            : unreads > 0
              ? "font-medium text-body hover:bg-input"
              : "text-muted hover:bg-input hover:text-body"
        }`}
      >
        <span className="shrink-0 font-mono text-faint">#</span>
        <span className="min-w-0 truncate">{c}</span>
        {pinnedChannels.includes(c) && (
          <PinIcon className="ml-auto h-3 w-3 shrink-0 text-faint" />
        )}
        {unreads > 0 && (
          <span className="ml-auto shrink-0 font-mono text-[11px] font-bold text-accent">
            {unreads > 99 ? "99+" : unreads}
          </span>
        )}
      </button>
    );
  };

  const byName = (a: Participant, b: Participant) => a.name.localeCompare(b.name);
  const online = participants.filter((p) => p.online).sort(byName);
  const offline = participants.filter((p) => !p.online).sort(byName);
  const selectedMember = selected
    ? (participants.find((p) => p.id === selected.participantId) ?? null)
    : null;
  const menuMember = memberMenu
    ? (participants.find((p) => p.id === memberMenu.participantId) ?? null)
    : null;
  // Agent removal only works for invite-created agents (server-wide-token
  // agents like the demo "noodle" have no invite to revoke); human removal
  // works for any other human, but never for yourself.
  const menuMemberInvite = menuMember
    ? (agentInvites.find((i) => i.actorId === menuMember.id) ?? null)
    : null;
  const menuMemberRemovable = menuMember
    ? menuMember.kind === "agent"
      ? menuMemberInvite !== null
      : menuMember.id !== self?.id
    : false;

  const discuss = (item: BoardItem) => {
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
    <aside className="flex h-full w-60 flex-col border-r border-divider">
      {/* Status area — top third, becomes the status strip. The workspace
          name lives in the StatusBar, not in a sidebar header. */}
      <section className="min-h-0 basis-1/3 overflow-y-auto px-2 pt-3">
        <h2 className="mb-1 px-2 font-mono text-[10px] font-bold tracking-wider text-muted uppercase select-none">
          Online — {online.length}
        </h2>
        {online.map((p) => (
          <StatusRow
            key={p.id}
            participant={p}
            onSelect={(m, anchor) => setSelected({ participantId: m.id, anchor })}
            onContextMenu={openMemberMenu}
          />
        ))}
        {offline.length > 0 && (
          <>
            <h2 className="mt-2 mb-1 px-2 font-mono text-[10px] font-bold tracking-wider text-muted uppercase select-none">
              Offline — {offline.length}
            </h2>
            {offline.map((p) => (
              <StatusRow
                key={p.id}
                participant={p}
                onSelect={(m, anchor) => setSelected({ participantId: m.id, anchor })}
                onContextMenu={openMemberMenu}
              />
            ))}
          </>
        )}
        {self?.kind === "human" && (
          <button
            onClick={() => setAddAgentOpen(true)}
            className="mt-2 flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-dashed border-divider px-2 py-2 text-left text-sm font-medium text-muted hover:border-faint hover:text-body select-none"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-subtle text-lg text-muted">
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
            className="flex cursor-pointer items-center gap-1 font-mono text-[10px] font-bold tracking-wider text-muted uppercase select-none hover:text-body"
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
            className="mb-0.5 w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
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
              className="mt-2 mb-1 flex items-center gap-1 px-2 font-mono text-[10px] font-bold tracking-wider text-muted uppercase select-none hover:text-body"
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
      <footer className="flex h-[52px] shrink-0 items-center gap-2 border-t border-divider px-2">
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
                className="shrink-0 cursor-pointer rounded-md px-1.5 py-1 text-xs text-muted select-none hover:bg-subtle-hover hover:text-body"
              >
                Sign out
              </button>
            )}
          </>
        )}
      </footer>

      {selectedMember && selected && (
        <MemberCard
          participant={selectedMember}
          channel={channel}
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
      {memberMenu && menuMember && (
        <MemberContextMenu
          x={memberMenu.x}
          y={memberMenu.y}
          name={menuMember.name}
          removable={menuMemberRemovable}
          onRemove={() => {
            if (!menuMemberRemovable) return;
            if (menuMember.kind === "agent") {
              if (menuMemberInvite) void revokeAgent(menuMemberInvite.id);
            } else {
              void removeMember(menuMember.id);
            }
          }}
          onClose={() => setMemberMenu(null)}
        />
      )}
      <AddAgentModal open={addAgentOpen} onClose={() => setAddAgentOpen(false)} />
    </aside>
  );
}
