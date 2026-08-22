import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardItem, ChannelSection, Participant } from "@workspace/shared";
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

/** Small chevron after a label. Collapsible sections point right when closed
 *  (default); dropdown menus flip up when open (`flip`). */
export function ChevronIcon({
  open,
  flip,
  className,
}: {
  open: boolean;
  flip?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${className ?? ""} transition-transform ${
        flip ? (open ? "rotate-180" : "") : open ? "" : "-rotate-90"
      }`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
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
  moveTargets,
  onMarkRead,
  onTogglePin,
  onRename,
  onToggleArchive,
  onMove,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  channel: string;
  pinned: boolean;
  archived: boolean;
  confirmingDelete: boolean;
  moveTargets: { id: string | null; name: string }[];
  onMarkRead: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onToggleArchive: () => void;
  onMove: (sectionId: string | null) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });
  const [moveOpen, setMoveOpen] = useState(false);
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
      {moveTargets.length > 0 && (
        <>
          <ContextMenuItem
            label={moveOpen ? "Move ▾" : "Move ▸"}
            onClick={() => setMoveOpen((open) => !open)}
          />
          {moveOpen &&
            moveTargets.map((target) => (
              <ContextMenuItem
                key={target.id ?? "rooms"}
                label={target.name}
                onClick={() => {
                  onMove(target.id);
                  onClose();
                }}
              />
            ))}
        </>
      )}
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
  approvalCount,
  onSelect,
  onContextMenu,
  rowRef,
}: {
  participant: Participant;
  /** Requests attributed to this agent (permission, resource, project) still waiting on a human. */
  approvalCount: number;
  onSelect: (participant: Participant, anchor: DOMRect) => void;
  onContextMenu: (participant: Participant, e: React.MouseEvent) => void;
  /** Lets the parent grab this row's rect to auto-pop the card without a click. */
  rowRef?: (el: HTMLDivElement | null) => void;
}) {
  const isAgent = participant.kind === "agent";
  const working = isAgent && participant.runState === "working";
  const blocked = isAgent && participant.runState === "blocked";
  const dead = isAgent && participant.runState === "dead";
  const offline = !participant.online;
  const needsApproval = isAgent && approvalCount > 0;
  return (
    <div
      ref={rowRef}
      className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 select-none hover:bg-input ${
        offline ? "opacity-40 hover:opacity-100" : ""
      }`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => onSelect(participant, e.currentTarget.getBoundingClientRect())}
      onContextMenu={(e) => onContextMenu(participant, e)}
    >
      <div className="relative">
        <Avatar name={participant.name} size={32} grayscale={offline} mascot={participant.managedAgent === "noodle"} />
        <PresenceDot participant={participant} />
        {needsApproval && (
          <span
            title={`${approvalCount} awaiting your approval`}
            className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-canvas bg-accent"
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative text-[9px] leading-none font-bold text-on-accent">!</span>
          </span>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-body">
          {participant.name}
          {isAgent && <AgentBadge className="ml-1.5 align-middle" />}
        </div>
        <div
          className={`truncate text-xs ${
            needsApproval
              ? "font-bold text-accent"
              : working
                ? "font-medium text-working"
                : blocked || dead
                  ? "font-medium text-dead"
                  : "text-muted"
          }`}
        >
          {dead
            ? `Dead${participant.status ? ` — ${participant.status}` : ""}`
            : needsApproval
              ? `Needs your approval${approvalCount > 1 ? ` (${approvalCount})` : ""}`
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
  canManageMembers = true,
  addAgentOpen,
  onAddAgentOpenChange,
}: {
  channel: string;
  onSelectChannel: (channel: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onPrefill: (text: string) => void;
  canManageMembers?: boolean;
  addAgentOpen?: boolean;
  onAddAgentOpenChange?: (open: boolean) => void;
}) {
  const {
    participants,
    self,
    channels,
    channelInfos,
    archivedChannels,
    pinnedChannels,
    channelSections,
    setStatus,
    signOut,
    createChannel,
    createChannelSection,
    renameChannel,
    archiveChannel,
    pinChannel,
    deleteChannel,
    moveChannel,
    unreadCount,
    markRead,
    agentInvites,
    revokeAgent,
    removeMember,
    pendingInteractions,
    pendingResourceAccessRequests,
    pendingProjectAccessRequests,
  } = useWorkspace();
  const approvalCountFor = (agentId: string) =>
    pendingInteractions.filter((r) => r.agentId === agentId).length +
    pendingResourceAccessRequests.filter((r) => r.agentId === agentId).length +
    pendingProjectAccessRequests.filter((r) => r.agentId === agentId).length;
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
  const [selected, setSelected] = useState<{
    participantId: string;
    anchor: DOMRect;
  } | null>(null);
  const [creatingRoomFor, setCreatingRoomFor] = useState<string | null>(null);
  const [roomDraft, setRoomDraft] = useState("");
  const [creatingSection, setCreatingSection] = useState(false);
  const [sectionDraft, setSectionDraft] = useState("");
  const [roomsOpen, setRoomsOpen] = useState(true);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [dropTarget, setDropTarget] = useState<string | null>(null);
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
  const [localAddAgentOpen, setLocalAddAgentOpen] = useState(false);
  const addAgentOpenState = addAgentOpen ?? localAddAgentOpen;
  const setAddAgentOpen = onAddAgentOpenChange ?? setLocalAddAgentOpen;
  const [renamingChannel, setRenamingChannel] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteChannel, setConfirmDeleteChannel] = useState<string | null>(null);
  const deleteTimerRef = useRef<number | null>(null);

  // Pinned rooms bubble to the top of their section; otherwise the server's order holds.
  const sortInSection = (names: string[]) =>
    [...names].sort((a, b) => Number(pinnedChannels.includes(b)) - Number(pinnedChannels.includes(a)));
  const knownIds = new Set(channelSections.map((section) => section.id));
  const roomsChannels = sortInSection(
    channels.filter((name) => {
      const sectionId = channelInfos.find((info) => info.name === name)?.sectionId ?? null;
      return !sectionId || !knownIds.has(sectionId);
    }),
  );
  const channelsBySection = (section: ChannelSection) =>
    sortInSection(
      channels.filter((name) => channelInfos.find((info) => info.name === name)?.sectionId === section.id),
    );
  const isSectionOpen = (id: string) => openSections[id] !== false;
  const moveTargetsFor = (name: string) => {
    const current = channelInfos.find((info) => info.name === name)?.sectionId ?? null;
    const targets: { id: string | null; name: string }[] = [];
    if (current !== null) targets.push({ id: null, name: "Rooms" });
    for (const section of channelSections) {
      if (section.id !== current) targets.push({ id: section.id, name: section.name });
    }
    return targets;
  };

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
      <div
        key={c}
        role="tab"
        tabIndex={0}
        draggable
        aria-selected={c === channel}
        onClick={() => onSelectChannel(c)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectChannel(c);
          }
        }}
        onContextMenu={(e) => openRoomMenu(e, c)}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", c);
          e.dataTransfer.effectAllowed = "move";
        }}
        className={`mb-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-sm select-none ${
          c === channel || contextMenu?.channel === c
            ? "bg-input font-semibold text-body"
            : unreads > 0
              ? "font-medium text-body hover:bg-input"
              : "text-muted hover:bg-input hover:text-body"
        }`}
      >
        <span className="shrink-0 text-faint">#</span>
        <span className="min-w-0 truncate">{c}</span>
        {pinnedChannels.includes(c) && (
          <PinIcon className="ml-auto h-3 w-3 shrink-0 text-faint" />
        )}
        {unreads > 0 && (
          <span className="ml-auto shrink-0 text-[11px] font-bold text-accent">
            {unreads > 99 ? "99+" : unreads}
          </span>
        )}
      </div>
    );
  };

  const byName = (a: Participant, b: Participant) => a.name.localeCompare(b.name);
  const online = participants.filter((p) => p.online).sort(byName);
  const offline = participants.filter((p) => !p.online).sort(byName);

  // Auto-pop the card the moment an agent's approval count rises above what
  // it was last render — the sidebar badge alone is easy to miss, and the
  // user asked for it to "pop out" rather than stay a passive flash.
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevApprovalCounts = useRef(new Map<string, number>());
  useEffect(() => {
    for (const p of participants) {
      if (p.kind !== "agent") continue;
      const count = approvalCountFor(p.id);
      const prev = prevApprovalCounts.current.get(p.id) ?? 0;
      prevApprovalCounts.current.set(p.id, count);
      if (count > prev) {
        const el = rowRefs.current.get(p.id);
        if (el) setSelected({ participantId: p.id, anchor: el.getBoundingClientRect() });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInteractions, pendingResourceAccessRequests, pendingProjectAccessRequests]);
  const selectedMember = selected
    ? (participants.find((p) => p.id === selected.participantId) ?? null)
    : null;
  const menuMember = memberMenu
    ? (participants.find((p) => p.id === memberMenu.participantId) ?? null)
    : null;
  // Invite-created agents revoke through their invite. Built-in noodle
  // uses ordinary membership removal (owners only). Humans never remove themselves.
  const menuMemberInvite = menuMember
    ? (agentInvites.find((i) => i.actorId === menuMember.id) ?? null)
    : null;
  const menuMemberRemovable = menuMember
    ? menuMember.kind === "agent"
      ? menuMemberInvite !== null || (canManageMembers && menuMember.managedAgent === "noodle")
      : canManageMembers && menuMember.id !== self?.id
    : false;

  const discuss = (item: BoardItem) => {
    setSelected(null);
    onDiscuss(item);
  };

  const submitRoom = async () => {
    const name = roomDraft.trim();
    const sectionId = creatingRoomFor === "rooms" ? null : creatingRoomFor;
    if (!name) {
      setCreatingRoomFor(null);
      return;
    }
    const created = await createChannel(name, sectionId);
    // On failure the input stays open with the draft; the toast has the error.
    if (created) {
      setCreatingRoomFor(null);
      setRoomDraft("");
      onSelectChannel(created);
    }
  };

  const roomDraftInput = (sectionId: string) =>
    creatingRoomFor === sectionId ? (
      <input
        autoFocus
        aria-label={sectionId === "rooms" ? "New room name" : `New room name in ${channelSections.find((section) => section.id === sectionId)?.name ?? "section"}`}
        value={roomDraft}
        onChange={(e) => setRoomDraft(e.target.value)}
        // Blur closes but keeps the draft; Escape closes and discards it.
        onBlur={() => setCreatingRoomFor(null)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setRoomDraft("");
            setCreatingRoomFor(null);
          }
          if (e.key === "Enter") void submitRoom();
        }}
        maxLength={32}
        placeholder="new-room"
        className="mb-0.5 w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
      />
    ) : null;

  const submitSection = async () => {
    const name = sectionDraft.trim();
    if (!name) {
      setCreatingSection(false);
      return;
    }
    const created = await createChannelSection(name);
    if (created) {
      setCreatingSection(false);
      setSectionDraft("");
      setOpenSections((prev) => ({ ...prev, [created.id]: true }));
    }
  };

  const dropOnSection = (sectionId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const name = e.dataTransfer.getData("text/plain");
    if (!name) return;
    const current = channelInfos.find((info) => info.name === name)?.sectionId ?? null;
    if (current === sectionId) return;
    void moveChannel(name, sectionId);
  };

  const allowDrop = (sectionId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(sectionId ?? "rooms");
  };

  const leaveDrop = (sectionId: string | null) => (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropTarget((current) => (current === (sectionId ?? "rooms") ? null : current));
  };

  const sectionDropProps = (sectionId: string | null) => ({
    onDragOver: allowDrop(sectionId),
    onDragEnter: allowDrop(sectionId),
    onDragLeave: leaveDrop(sectionId),
    onDrop: dropOnSection(sectionId),
  });

  return (
    <aside className="flex h-full w-60 flex-col border-r border-divider">
      {/* Status area — top third, becomes the status strip. The workspace
          name lives in the StatusBar, not in a sidebar header. */}
      <section className="min-h-0 basis-1/3 overflow-y-auto px-2 pt-3">
        <h2 className="mb-1 px-2 text-[10px] font-bold tracking-wider text-muted uppercase select-none">
          Online — {online.length}
        </h2>
        {online.map((p) => (
          <StatusRow
            key={p.id}
            participant={p}
            approvalCount={approvalCountFor(p.id)}
            onSelect={(m, anchor) => setSelected({ participantId: m.id, anchor })}
            onContextMenu={openMemberMenu}
            rowRef={(el) => {
              if (el) rowRefs.current.set(p.id, el);
              else rowRefs.current.delete(p.id);
            }}
          />
        ))}
        {offline.length > 0 && (
          <>
            <h2 className="mt-2 mb-1 px-2 text-[10px] font-bold tracking-wider text-muted uppercase select-none">
              Offline — {offline.length}
            </h2>
            {offline.map((p) => (
              <StatusRow
                key={p.id}
                participant={p}
                approvalCount={approvalCountFor(p.id)}
                onSelect={(m, anchor) => setSelected({ participantId: m.id, anchor })}
                onContextMenu={openMemberMenu}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(p.id, el);
                  else rowRefs.current.delete(p.id);
                }}
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

      {/* Rooms and custom sections */}
      <section className="min-h-0 flex-1 overflow-y-auto border-t border-divider px-2 pt-3">
        <div className="group mb-1 flex items-center justify-between px-2">
          <button
            onClick={() => setRoomsOpen((o) => !o)}
            className="flex cursor-pointer items-center gap-0.5 text-[11px] font-semibold tracking-wider text-muted uppercase select-none hover:text-body"
          >
            Rooms
            <ChevronIcon open={roomsOpen} className="h-3 w-3" />
          </button>
          <button
            aria-label="Create a room"
            onClick={() => {
              setRoomsOpen(true);
              setCreatingRoomFor("rooms");
            }}
            className="cursor-pointer rounded px-1 text-sm leading-none text-muted opacity-0 transition-opacity select-none group-hover:opacity-100 hover:text-body focus-visible:opacity-100"
          >
            +
          </button>
        </div>
        {roomDraftInput("rooms")}
        <div
          {...sectionDropProps(null)}
          className={`rounded-md ${dropTarget === "rooms" ? "bg-input" : ""}`}
        >
        {roomsOpen && (
          <div role="tablist" aria-label="Rooms" className="min-h-6">
            {roomsChannels.map(renderRoom)}
          </div>
        )}
        </div>
        {channelSections.map((section) => (
          <div
            key={section.id}
            className={`mt-5 rounded-md ${dropTarget === section.id ? "bg-input" : ""}`}
            {...sectionDropProps(section.id)}
          >
            <div className="group mb-1 flex items-center justify-between px-2">
              <button
                aria-label={`${section.name} section`}
                onClick={() =>
                  setOpenSections((prev) => ({ ...prev, [section.id]: !isSectionOpen(section.id) }))
                }
                className="flex cursor-pointer items-center gap-0.5 text-[11px] font-semibold tracking-wider text-muted uppercase select-none hover:text-body"
              >
                {section.name}
                <ChevronIcon open={isSectionOpen(section.id)} className="h-3 w-3" />
              </button>
              <button
                aria-label={`Create a room in ${section.name}`}
                onClick={() => {
                  setOpenSections((prev) => ({ ...prev, [section.id]: true }));
                  setCreatingRoomFor(section.id);
                }}
                className="cursor-pointer rounded px-1 text-sm leading-none text-muted opacity-0 transition-opacity select-none group-hover:opacity-100 hover:text-body focus-visible:opacity-100"
              >
                +
              </button>
            </div>
            {roomDraftInput(section.id)}
            {isSectionOpen(section.id) && (
              <div role="tablist" aria-label={section.name} className="min-h-6">
                {channelsBySection(section).map(renderRoom)}
              </div>
            )}
          </div>
        ))}
        {creatingSection && (
          <input
            autoFocus
            aria-label="New section name"
            value={sectionDraft}
            onChange={(e) => setSectionDraft(e.target.value)}
            onBlur={() => setCreatingSection(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSectionDraft("");
                setCreatingSection(false);
              }
              if (e.key === "Enter") void submitSection();
            }}
            maxLength={32}
            placeholder="new-section"
            className="mt-2 mb-0.5 w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
          />
        )}
        <button
          aria-label="Create a section"
          onClick={() => setCreatingSection(true)}
          className="mt-5 mb-1 flex w-full cursor-pointer items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wider text-muted uppercase select-none hover:text-body"
        >
          + Add section
        </button>

        {archivedChannels.length > 0 && (
          <>
            <button
              onClick={() => setArchivedOpen((o) => !o)}
              className="mt-5 mb-1 flex items-center gap-0.5 px-2 text-[11px] font-semibold tracking-wider text-muted uppercase select-none hover:text-body"
            >
              Archived — {archivedChannels.length}
              <ChevronIcon open={archivedOpen} className="h-3 w-3" />
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
          onSwitchChannel={onSelectChannel}
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
          moveTargets={moveTargetsFor(contextMenu.channel)}
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
          onMove={(sectionId) => void moveChannel(contextMenu.channel, sectionId)}
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
            if (menuMemberInvite) void revokeAgent(menuMemberInvite.id);
            else void removeMember(menuMember.id);
          }}
          onClose={() => setMemberMenu(null)}
        />
      )}
      <AddAgentModal open={addAgentOpenState} onClose={() => setAddAgentOpen(false)} />
    </aside>
  );
}
