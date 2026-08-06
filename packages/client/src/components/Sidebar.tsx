import { useState } from "react";
import type { BoardItem, Participant } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { presenceDot, presenceLabel } from "../lib/status";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { ApprovalQueue } from "./ApprovalQueue";
import { MemberCard } from "./MemberCard";

const SERVER_NAME = "Workspace";

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
      className={`flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 select-none hover:bg-white/5 ${
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
  const { participants, self, channels, board, setStatus, signOut, createChannel } =
    useWorkspace();
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [selected, setSelected] = useState<{
    participantId: string;
    anchor: DOMRect;
  } | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [roomDraft, setRoomDraft] = useState("");

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
        <span className="truncate font-semibold text-body">{SERVER_NAME}</span>
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
      </section>

      {/* Rooms */}
      <section className="min-h-0 flex-1 overflow-y-auto border-t border-divider px-2 pt-3">
        <div className="mb-1 flex items-center justify-between px-2">
          <h2 className="text-[11px] font-bold tracking-wide text-muted uppercase select-none">
            Rooms
          </h2>
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
        <div role="tablist" aria-label="Rooms">
          {channels.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={c === channel}
              onClick={() => onSelectChannel(c)}
              className={`mb-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left font-medium select-none ${
                c === channel
                  ? "bg-input text-body"
                  : "text-muted hover:bg-input/70 hover:text-body"
              }`}
            >
              <span className="shrink-0 text-[15px] text-faint">#</span>
              <span className="min-w-0 truncate text-[15px]">{c}</span>
            </button>
          ))}
        </div>
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
                className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-[11px] text-muted select-none hover:bg-white/5 hover:text-body"
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
    </aside>
  );
}
