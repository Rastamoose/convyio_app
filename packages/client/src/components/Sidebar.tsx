import { useState } from "react";
import type { BoardItem, ChatMessage, Participant } from "@workspace/shared";
import type { ActiveRun } from "../hooks/useWorkspace";
import { Avatar } from "./Avatar";
import { ApprovalQueue } from "./ApprovalQueue";
import { MemberCard } from "./MemberCard";

const SERVER_NAME = "Workspace";

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-[2.5px] border-sidebar ${
        online ? "bg-online" : "bg-offline"
      }`}
    />
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
        {working ? (
          <span className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full border-[2.5px] border-sidebar bg-sidebar">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-online opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-online" />
          </span>
        ) : blocked ? (
          <span className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full border-[2.5px] border-sidebar bg-sidebar">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-dead opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-dead" />
          </span>
        ) : dead ? (
          <span className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-[2.5px] border-sidebar bg-dead" />
        ) : isAgent ? (
          <span
            className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-[2.5px] border-sidebar ${
              participant.online ? "bg-away" : "bg-offline"
            }`}
          />
        ) : (
          <StatusDot online={participant.online} />
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-body">
          {participant.name}
          {isAgent && (
            <span className="ml-1.5 rounded bg-blurple px-1 py-px align-middle text-[10px] font-bold text-mention-text">
              AGENT
            </span>
          )}
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
  participants,
  self,
  channels,
  channel,
  onSelectChannel,
  onSetStatus,
  board,
  activeRuns,
  messages,
  onApprove,
  onDeny,
  onDiscuss,
  onPrefill,
}: {
  participants: Participant[];
  self: Participant | null;
  channels: string[];
  channel: string;
  onSelectChannel: (channel: string) => void;
  onSetStatus: (status: string) => void;
  board: BoardItem[];
  activeRuns: ActiveRun[];
  messages: ChatMessage[];
  onApprove: (itemId: string) => void;
  onDeny: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onPrefill: (text: string) => void;
}) {
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
        <h2 className="mb-1 px-2 text-[11px] font-bold tracking-wide text-muted uppercase">
          Rooms
        </h2>
        {channels.map((c) => (
          <button
            key={c}
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
      </section>

      {/* User panel */}
      <footer className="flex h-[52px] shrink-0 items-center gap-2 bg-userpanel px-2">
        {self && (
          <>
            <div className="relative">
              <Avatar name={self.name} size={32} />
              <StatusDot online />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-body">
                {self.name}
              </div>
              {editingStatus ? (
                <input
                  autoFocus
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value)}
                  onBlur={() => {
                    onSetStatus(statusDraft);
                    setEditingStatus(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onSetStatus(statusDraft);
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
            <button
              className="rounded p-1.5 text-muted hover:bg-input hover:text-body"
              title="Settings"
            >
              <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94a7.07 7.07 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7.05 7.05 0 00-1.63-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 00-.61.22L2.63 8.84a.5.5 0 00.12.64l2.03 1.58a7.07 7.07 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.31.61.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.09.48 0 .61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z" />
              </svg>
            </button>
          </>
        )}
      </footer>

      {queueOpen && pendingItems.length > 0 && (
        <ApprovalQueue
          items={pendingItems}
          onApprove={onApprove}
          onDeny={onDeny}
          onDiscuss={discuss}
          onClose={() => setQueueOpen(false)}
        />
      )}
      {selected && (
        <MemberCard
          participant={selected}
          board={board}
          activeRuns={activeRuns}
          messages={messages}
          onApprove={onApprove}
          onDeny={onDeny}
          onDiscuss={discuss}
          onPrefill={onPrefill}
          onClose={() => setSelectedId(null)}
        />
      )}
    </aside>
  );
}
