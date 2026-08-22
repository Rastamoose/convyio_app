import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardItem, Participant } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { formatElapsed } from "../lib/format";
import { presenceLabel } from "../lib/status";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { ProposalCard } from "./ProposalCard";
import { PermissionCard } from "./PermissionCard";
import { ResourceAccessRequestCard } from "./ResourceAccessRequestCard";
import { ProjectAccessRequestCard } from "./ProjectAccessRequestCard";

/**
 * How much of an item's board grant runs without asking. The grant is the
 * ceiling either way — this only decides what pauses for a human.
 */
const MODES = [
  { mode: "default", label: "Ask", hint: "Ask before every change" },
  { mode: "acceptEdits", label: "Edits", hint: "Apply file edits; still ask for commands" },
  { mode: "approveAll", label: "All", hint: "Apply classified mutations after the hard ceiling" },
  { mode: "bypass", label: "Bypass", hint: "Same as All: never overrides sandbox or identity" },
  { mode: "plan", label: "Plan", hint: "Read and plan only; change nothing" },
] as const;

export function MemberCard({
  participant,
  channel,
  anchor,
  onDiscuss,
  onPrefill,
  onClose,
  onSwitchChannel,
}: {
  participant: Participant;
  /** Channel the permission mode applies to; mode is per agent per channel. */
  channel: string;
  /** Viewport rect of the sidebar row that opened the card. */
  anchor: DOMRect;
  onDiscuss: (item: BoardItem) => void;
  onPrefill: (text: string) => void;
  onClose: () => void;
  /** Jump-to-trace's target can be in a different channel than the one open now. */
  onSwitchChannel: (channel: string) => void;
}) {
  const {
    board,
    activeRuns,
    messages,
    setPermissionMode,
    agentInvites,
    participants,
    self,
    setAgentActive,
    refreshAgents,
    pendingInteractions,
    pendingResourceAccessRequests,
    pendingProjectAccessRequests,
    resolveInteraction,
    resolveResourceAccessRequest,
    resolveProjectAccessRequest,
    conversationModes,
    channelInfos,
  } = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  const [top, setTop] = useState(anchor.top);

  // Align with the clicked row, clamped so the card never runs past the
  // viewport bottom (layout effect: measured height, adjusted before paint).
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8)));
  }, [anchor, participant]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  const isAgent = participant.kind === "agent";
  const channelId = channelInfos.find((info) => info.name === channel)?.id ?? channel;
  const currentMode = conversationModes.get(`${participant.id}:${channelId}`) ?? "default";

  // Runner health is not pushed over the socket, so poll while the card is
  // open — otherwise clicking "Wake up"/"Put to sleep" looks broken: the
  // click lands, but the button never reflects it until the card is closed
  // and reopened. Same pattern as AddAgentModal's pair/configure polling.
  const refresh = useRef(refreshAgents);
  refresh.current = refreshAgents;
  useEffect(() => {
    if (!isAgent) return;
    void refresh.current();
    const id = window.setInterval(() => void refresh.current(), 3000);
    return () => window.clearInterval(id);
  }, [isAgent, participant.id]);

  // Only paired runners have a sleep/wake switch; managed agents like noodle
  // are not in the invite list and correctly get no runner controls.
  const invite = isAgent ? agentInvites.find((a) => a.actorId === participant.id) : undefined;
  const asleep = invite?.runtime.health === "dormant";
  const ownsAgent = !!invite && self?.id === invite.createdBy;
  const ownerName = invite && participants.find((p) => p.id === invite.createdBy)?.name;

  const currentTask = participant.currentTaskId
    ? board.find(
        (b) =>
          b.id === participant.currentTaskId ||
          b.ref === participant.currentTaskId,
      )
    : undefined;
  const pendingItem = isAgent
    ? board.find(
        (b) => b.status === "proposed" && b.createdBy === participant.id,
      )
    : undefined;

  // Same requests the channel and the board already render — this is a
  // shortcut to them, not a second copy.
  const myInteractions = isAgent
    ? pendingInteractions.filter((r) => r.agentId === participant.id)
    : [];
  const myResourceRequests = isAgent
    ? pendingResourceAccessRequests.filter((r) => r.agentId === participant.id)
    : [];
  const myProjectRequests = isAgent
    ? pendingProjectAccessRequests.filter((r) => r.agentId === participant.id)
    : [];
  const needsApproval =
    myInteractions.length + myResourceRequests.length + myProjectRequests.length > 0;

  const liveRun = activeRuns.find((r) => r.agentName === participant.name);
  const lastRunMessage = [...messages]
    .reverse()
    .find((m) => m.authorId === participant.id && m.runId);
  // The target can be in a different channel than the one open right now
  // (this card shows the agent's single most recent run/message across all
  // channels) — jumpTarget carries the channel name so the click handler can
  // switch first; without it document.getElementById silently finds nothing.
  const jumpTarget = liveRun
    ? { id: `trace-${liveRun.runId}`, channel: channelInfos.find((c) => c.id === liveRun.channelId)?.name }
    : lastRunMessage
      ? { id: `msg-${lastRunMessage.id}`, channel: lastRunMessage.channel }
      : null;

  const mention = () => {
    onClose();
    onPrefill(
      currentTask
        ? `@${participant.name} re: ${currentTask.ref} `
        : `@${participant.name} `,
    );
  };

  return (
    <div
      ref={ref}
      style={{ top, left: anchor.right + 8 }}
      className="elevated animate-pop-in fixed z-50 max-h-[70vh] w-80 overflow-y-auto rounded-lg p-4"
    >
      <div className="mb-3 flex items-center gap-3">
        <Avatar name={participant.name} size={48} mascot={participant.managedAgent === "noodle"} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-body">
            {participant.name}
            {isAgent && <AgentBadge className="ml-1.5 align-middle" />}
          </div>
          <div className="truncate text-xs text-muted" title={presenceLabel(participant)}>
            {presenceLabel(participant)}
            {!isAgent && participant.status ? ` — ${participant.status}` : ""}
          </div>
        </div>
      </div>
      {isAgent && (
        <>
          {needsApproval && (
            <div className="mb-3 space-y-2">
              <div className="text-[10px] font-bold tracking-wider text-accent uppercase">
                Needs your approval
              </div>
              {myInteractions.map((request) => (
                <PermissionCard key={request.id} request={request} onResolve={resolveInteraction} />
              ))}
              {myResourceRequests.map((request) => (
                <ResourceAccessRequestCard
                  key={request.id}
                  request={request}
                  onResolve={resolveResourceAccessRequest}
                  compact
                />
              ))}
              {myProjectRequests.map((request) => (
                <ProjectAccessRequestCard
                  key={request.id}
                  request={request}
                  onResolve={resolveProjectAccessRequest}
                  compact
                />
              ))}
            </div>
          )}
          <div className="mb-3">
            <div className="mb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
              Permissions in #{channel}
            </div>
            <div className="flex gap-1">
              {MODES.map(({ mode, label, hint }) => (
                <button
                  key={mode}
                  title={hint}
                  onClick={() => setPermissionMode(participant.id, channel, mode)}
                  className={`flex-1 cursor-pointer rounded-md px-1.5 py-1 text-[11px] select-none ${
                    mode === currentMode
                      ? "bg-accent text-on-accent"
                      : "text-muted hover:bg-subtle-hover hover:text-body"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-3">
            <div className="mb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
              Current task
            </div>
            {currentTask ? (
              <div className="text-sm text-body">
                <span className="rounded bg-accent px-1 py-px text-[10px] font-bold text-on-accent">
                  {currentTask.ref}
                </span>{" "}
                {currentTask.title}
                {participant.taskStartedAt != null && (
                  <span className="ml-1.5 text-xs text-faint">
                    {formatElapsed(now - participant.taskStartedAt)}
                  </span>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted">No active task</div>
            )}
          </div>
          {invite && (
            <div className="mb-3">
              <div className="mb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
                Runner
              </div>
              <button
                disabled={!ownsAgent || !invite.runtime.connected}
                onClick={() => setAgentActive(participant.id, asleep)}
                className="w-full cursor-pointer rounded-md bg-subtle px-2 py-1.5 text-xs font-semibold text-body hover:bg-subtle-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-subtle"
              >
                {asleep ? "Wake up" : "Put to sleep"}
              </button>
              {!invite.runtime.connected ? (
                <p className="mt-1 text-xs text-faint">
                  Offline — it can only be woken while the computer it is paired to is running.
                </p>
              ) : !ownsAgent ? (
                <p className="mt-1 text-xs text-faint">
                  {ownerName ? `Only ${ownerName}` : "Only the person who added this agent"} can{" "}
                  {asleep ? "wake" : "sleep"} it — it runs on their computer.
                </p>
              ) : asleep ? (
                <p className="mt-1 text-xs text-faint">
                  Asleep: connected, but running nothing and touching no files until you wake it.
                </p>
              ) : null}
            </div>
          )}
          {pendingItem && (
            <div className="mb-3">
              <div className="mb-1 text-[10px] font-bold tracking-wider text-dead uppercase">
                Pending request
              </div>
              <ProposalCard
                item={pendingItem}
                onDiscuss={(item) => {
                  onClose();
                  onDiscuss(item);
                }}
              />
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              disabled={!jumpTarget}
              onClick={() => {
                if (!jumpTarget) return;
                const scroll = () =>
                  document.getElementById(jumpTarget.id)?.scrollIntoView({ behavior: "smooth" });
                if (jumpTarget.channel && jumpTarget.channel !== channel) {
                  onSwitchChannel(jumpTarget.channel);
                  // Wait a paint for the target channel's messages to mount.
                  requestAnimationFrame(() => requestAnimationFrame(scroll));
                } else {
                  scroll();
                }
              }}
              className="flex-1 cursor-pointer rounded-md bg-subtle px-2 py-1.5 text-xs font-semibold text-body hover:bg-subtle-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-subtle"
            >
              Jump to trace
            </button>
            <button
              onClick={mention}
              className="flex-1 cursor-pointer rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-on-accent transition hover:bg-accent-hover"
            >
              Mention
            </button>
          </div>
        </>
      )}
    </div>
  );
}
