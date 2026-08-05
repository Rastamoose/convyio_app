import { useState } from "react";
import type { BoardItem, Participant } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { presenceDot } from "../lib/status";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { ApprovalQueue } from "./ApprovalQueue";
import { MemberCard } from "./MemberCard";

const SERVER_NAME = "Workspace";

function PresenceDot({ participant }: { participant: Participant }) {
  const { color, pulse } = presenceDot(participant);
  if (!pulse) {
    return (
      <span
        className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-[2.5px] border-sidebar ${color}`}
      />
    );
  }
  return (
    <span className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full border-[2.5px] border-sidebar bg-sidebar">
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${color}`}
      />
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

function StatusRow({
  participant,
  onSelect,
}: {
  participant: Participant;
  onSelect: (participant: Participant) => void;
}) {
  const isAgent = participant.kind === "agent";
  const working = isAgent && participant.runState === "working";
  const blocked = isAgent && participant.runState === "blocked";
  const dead = isAgent && participant.runState === "dead";
  return (
    <div
      className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 hover:bg-white/5"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => onSelect(participant)}
    >
      <div className="relative">
        <Avatar name={participant.name} size={32} />
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [roomDraft, setRoomDraft] = useState("");

  const sorted = [...participants].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
  const pendingItems = board.filter((i) => i.status === "proposed");
  const selected = participants.find((p) => p.id === selectedId) ?? null;

  const discuss = (item: BoardItem) => {
    setQueueOpen(false);
    setSelectedId(null);
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
      <header className="flex h-12 shrink-0 flex-col justify-center border-b border-sidebar-dark px-4">
        <span className="truncate font-semibold text-body">{SERVER_NAME}</span>
        <span className="truncate text-[11px] leading-tight text-faint">
          humans &amp; agents, one room
        </span>
      </header>

      {/* Status area — top third, becomes the status strip */}
      <section className="min-h-0 basis-1/3 overflow-y-auto px-2 pt-3">
        <h2 className="mb-1 px-2 text-[11px] font-bold tracking-wide text-muted uppercase">
          Status — {sorted.filter((p) => p.online).length} online
        </h2>
        {pendingItems.length > 0 && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setQueueOpen((o) => !o)}
            className="mb-1.5 flex w-full items-center gap-2 rounded-lg bg-dead/20 px-2 py-1.5 text-left text-sm font-semibold text-dead hover:bg-dead/30"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-dead opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-dead" />
            </span>
            Awaiting approval ({pendingItems.length})
          </button>
        )}
        {sorted.map((p) => (
          <StatusRow key={p.id} participant={p} onSelect={(m) => setSelectedId(m.id)} />
        ))}
      </section>

      {/* Rooms */}
      <section className="min-h-0 flex-1 overflow-y-auto border-t border-divider px-2 pt-3">
        <div className="mb-1 flex items-center justify-between px-2">
          <h2 className="text-[11px] font-bold tracking-wide text-muted uppercase">
            Rooms
          </h2>
          <button
            aria-label="Create a room"
            onClick={() => {
              setRoomDraft("");
              setCreatingRoom(true);
            }}
            className="rounded px-1 text-sm leading-none text-muted hover:text-body"
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
            onBlur={() => setCreatingRoom(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreatingRoom(false);
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
              className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-medium ${
                c === channel
                  ? "bg-input text-body"
                  : "text-muted hover:bg-input/50 hover:text-body"
              }`}
            >
              <span
                className={`h-4 w-0.5 shrink-0 rounded-full ${
                  c === channel ? "bg-blurple" : "bg-divider"
                }`}
              />
              <span className="text-[15px]">{c}</span>
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
              <div className="truncate text-sm font-semibold text-body">
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
                  className="block w-full truncate text-left text-xs text-muted hover:text-body"
                >
                  {self.status || "Set a status…"}
                </button>
              )}
            </div>
            {signOut && (
              <button
                onClick={signOut}
                className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted hover:bg-white/5 hover:text-body"
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
      {selected && (
        <MemberCard
          participant={selected}
          onDiscuss={discuss}
          onPrefill={onPrefill}
          onClose={() => setSelectedId(null)}
        />
      )}
    </aside>
  );
}
