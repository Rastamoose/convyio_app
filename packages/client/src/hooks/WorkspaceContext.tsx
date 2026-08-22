import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  Actor,
  AgentAccessPolicy,
  AgentInvite,
  AgentProvider,
  AgentResourceAccessRequest,
  ProjectAccessRequest,
  AgentSummary,
  Attachment,
  ChannelInfo,
  ChannelSection,
  BoardItem,
  BoardItemEvent,
  BoardPlan,
  ContextEntry,
  ChatMessage,
  ClientEvent,
  InteractionRequest,
  PermissionMode,
  Participant,
  ThreadEvent,
  ToolExecution,
  WorkspaceInfo,
} from "@workspace/shared";
import { isBoardEnvelope, isPlanEnvelope } from "@workspace/shared";
import type { JoinCredentials } from "../ws";
import { useConnection } from "./useConnection";
import { useChatMessages, type LocalMessage } from "./useChatMessages";
import { useAgentTraces, type ActiveRun } from "./useAgentTraces";
import { useApiSession } from "./useApiSession";
import {
  useAttachmentDrafts,
  type AttachmentDraft,
} from "./useAttachmentDrafts";
import { useBoard, type BoardItemEdit, type BoardLine, type PlanDraft, type TicketDraft } from "./useBoard";
import { projectDemoProgress, type DemoProgressState } from "../lib/demoProgress";
import { useToasts, type Toast } from "./useToasts";
import { useTyping, type Typist } from "./useTyping";
import { useUnreads } from "./useUnreads";
import { useInteractions } from "./useInteractions";

export interface WorkspaceState {
  workspaceId: string;
  /** Workspace identity from the welcome frame; null until connected. */
  workspace: WorkspaceInfo | null;
  self: Participant | null;
  participants: Participant[];
  channels: string[];
  channelInfos: ChannelInfo[];
  archivedChannels: string[];
  pinnedChannels: string[];
  channelSections: ChannelSection[];
  demoChannels: string[];
  connected: boolean;
  messages: LocalMessage[];
  activeRuns: ActiveRun[];
  runDurations: Map<string, number>;
  executions: ToolExecution[];
  /** Permission prompts waiting on a human; the same ids every surface shows. */
  pendingInteractions: InteractionRequest[];
  resolveInteraction: (requestId: string, decision: "approve" | "deny") => void;
  /** Channel/project/workspace file access requests from agents that a human can approve or deny. */
  pendingResourceAccessRequests: AgentResourceAccessRequest[];
  resolveResourceAccessRequest: (requestId: string, decision: "approved" | "denied") => Promise<boolean>;
  /** Git/local project access requests — a separate legacy system from resource access, same "waiting on you" bucket. */
  pendingProjectAccessRequests: ProjectAccessRequest[];
  resolveProjectAccessRequest: (requestId: string, decision: "approved" | "denied") => Promise<boolean>;
  setPermissionMode: (agentId: string, channel: string, mode: PermissionMode) => void;
  board: BoardItem[];
  plans: BoardPlan[];
  context: ContextEntry[];
  boardLines: BoardLine[];
  toasts: Toast[];
  dismissToast: (id: number) => void;
  notify: (text: string) => void;
  sendMessage: (
    content: string,
    channel?: string,
    attachmentIds?: string[],
    replyToId?: string,
  ) => void;
  /** Re-send a failed optimistic message. */
  retryMessage: (nonce: string) => void;
  /** Drop a pending/failed optimistic message the user gave up on. */
  discardMessage: (nonce: string) => void;
  editMessage: (messageId: string, content: string) => void;
  deleteMessage: (messageId: string) => void;
  reactToMessage: (messageId: string, emoji: string, op: "add" | "remove") => void;
  /** Throttled outbound typing signal for the given channel. */
  sendTyping: (channel: string) => void;
  typistsIn: (channel: string) => Typist[];
  unreadCount: (channel: string) => number;
  /** Id of the first unread message as of the last channel switch, or null. */
  firstUnreadId: (channel: string) => string | null;
  markRead: (channel: string) => void;
  /** Fetches an older page of history for the channel; false = no more. */
  loadOlder: (channel: string) => Promise<boolean>;
  pinMessage: (messageId: string, pinned: boolean) => void;
  attachmentDraftsFor: (channel: string) => AttachmentDraft[];
  addAttachments: (channel: string, files: File[]) => void;
  removeAttachment: (channel: string, localId: string) => void;
  /** Clears the channel's drafts, returning the completed uploads' ids. */
  takeReadyAttachmentIds: (channel: string) => string[];
  /** Upload a file immediately and return the server attachment (no draft tray). */
  uploadAttachment: (file: File) => Promise<Attachment>;
  /** Displayable absolute URL for an attachment's server-relative url. */
  attachmentUrl: (attachment: Attachment) => string;
  setStatus: (status: string) => void;
  /** Ends the Google session; null in guest mode (nothing to sign out of). */
  signOut: (() => void) | null;
  clearMessages: () => void;
  interrupt: (target: string, content: string) => void;
  startDemo: (channel: string, mode?: "walkthrough" | "live") => void;
  demoControl: (channel: string, action: "pause" | "resume" | "continue" | "skip" | "replay") => void;
  demoProgress: DemoProgressState | null;
  /** Resolves to the created channel's normalized name, or null on failure. */
  createChannel: (name: string, sectionId?: string | null) => Promise<string | null>;
  /** Resolves to the channel's new normalized name, or null on failure. */
  renameChannel: (name: string, newName: string) => Promise<string | null>;
  archiveChannel: (name: string, archived: boolean) => Promise<boolean>;
  pinChannel: (name: string, pinned: boolean) => Promise<boolean>;
  deleteChannel: (name: string) => Promise<boolean>;
  createChannelSection: (name: string) => Promise<ChannelSection | null>;
  moveChannel: (name: string, sectionId: string | null) => Promise<boolean>;
  /** Resolves true when the item landed; false = failure (toast already shown). */
  createBoardItem: (draft: TicketDraft) => Promise<boolean>;
  createPlan: (draft: PlanDraft) => Promise<boolean>;
  addPlanConstraint: (planId: string, constraint: string) => Promise<boolean>;
  acceptPlan: (planId: string) => Promise<boolean>;
  approveItem: (itemId: string, owner?: string) => void;
  denyItem: (itemId: string) => void;
  startItem: (itemId: string) => void;
  completeItem: (itemId: string, evidence: string) => void;
  reopenItem: (itemId: string) => void;
  deleteItem: (itemId: string) => void;
  editItem: (itemId: string, fields: BoardItemEdit) => void;
  fetchActors: () => Promise<Actor[]>;
  fetchItemEvents: (itemId: string) => Promise<BoardItemEvent[]>;
  /** User-created agent invites currently on the server, each with live runtime state. */
  agentInvites: AgentSummary[];
  /** Absolute origin of the connected server (the same one `welcome.apiUrl` carried), for building agent setup commands. */
  apiUrl: string;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response> | null;
  /** Create a user-added agent and return its id plus the one-time pairing code; the invite token never reaches the UI. */
  createAgent: (fields: {
    name: string;
    provider: AgentProvider;
    instructions?: string;
    model?: string | null;
    access?: AgentAccessPolicy;
  }) => Promise<{ id: string; pairingCode: string } | null>;
  /** Update an agent's profile: instructions, model, and/or access policy. */
  updateAgent: (
    id: string,
    fields: { instructions?: string; model?: string | null; access?: AgentAccessPolicy },
  ) => Promise<boolean>;
  /** Issue a fresh pairing code for an existing agent, replacing any unused one. */
  repairAgent: (id: string) => Promise<string | null>;
  /** Revoke a user-added agent. */
  revokeAgent: (id: string) => Promise<boolean>;
  /** Wake or sleep a paired runner's local harness. Creator-only, enforced server-side. */
  setAgentActive: (actorId: string, active: boolean) => void;
  /** Re-fetch the agent list (and its runtime state) from the server. */
  refreshAgents: () => Promise<void>;
  /** Remove a human from the workspace (humans only; not self). */
  removeMember: (actorId: string) => Promise<boolean>;
  /** Owner-only restore of the built-in noodle member, without repeating welcome messages. */
  restoreNoodle: () => Promise<boolean>;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

/** Read the workspace from context. Must be rendered under WorkspaceProvider. */
export function useWorkspace(): WorkspaceState {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return workspace;
}

/**
 * WorkspaceProvider composes the workspace hooks (connection, chat, traces,
 * board, toasts) behind one context, so components never touch the socket or
 * HTTP API and App does not have to drill workspace props into every view.
 */
export function WorkspaceProvider({
  credentials,
  onAuthRejected,
  onSignOut,
  children,
}: {
  credentials: JoinCredentials;
  /** The server refused our session token; App owns what happens next. */
  onAuthRejected?: () => void;
  /** Present only when signed in via Google; guest mode has no sign-out. */
  onSignOut?: () => void;
  children: ReactNode;
}) {
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const chat = useChatMessages();
  const traces = useAgentTraces();
  const [executions, setExecutions] = useState<ToolExecution[]>([]);
  const [demoProgress, setDemoProgress] = useState<DemoProgressState | null>(null);
  const interactions = useInteractions();
  const [resourceAccessRequests, setResourceAccessRequests] = useState<AgentResourceAccessRequest[]>([]);
  const [projectAccessRequests, setProjectAccessRequests] = useState<ProjectAccessRequest[]>([]);
  const api = useApiSession();
  const attachments = useAttachmentDrafts(pushToast, api);
  const board = useBoard(pushToast, api);
  // Frames stashed by nonce so retry() can re-send the exact same content;
  // cleared once the send resolves (echo) or is discarded.
  const pendingFramesRef = useRef(new Map<string, ClientEvent>());

  const connection = useConnection(credentials, (event) => {
    if (isPlanEnvelope(event)) {
      board.applyPlan(event.plan);
      return;
    }
    if (isBoardEnvelope(event)) {
      board.applyEnvelope(event);
      // Surface new agent proposals even when the user is looking elsewhere;
      // skip the user's own (a human never proposes, but this guards against
      // ever notifying someone about their own action).
      if (event.type === "item.proposed" && event.actor.id !== connection.self?.id) {
        pushToast(
          `${event.actor.display_name} proposed: ${event.item.title}`,
          "info",
          { label: "View", itemId: event.item.id },
        );
      }
      return;
    }
    switch (event.type) {
      case "welcome":
        chat.replaceAll(event.history);
        traces.reset();
        setExecutions([]);
        interactions.reset();
        // The session must be bound before the board loads its snapshot.
        api.start(event.apiUrl, event.token);
        board.startSession();
        void api.fetch("/api/tool-executions")?.then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { executions?: ToolExecution[] };
          if (body.executions) setExecutions(body.executions);
        });
        break;
      case "message":
        chat.append(event.message, event.nonce);
        if (event.nonce) pendingFramesRef.current.delete(event.nonce);
        if (event.message.runId) traces.completeRun(event.message.runId);
        break;
      case "message_updated":
        chat.update(event.message);
        break;
      case "message_deleted":
        chat.remove(event.messageId);
        break;
      case "typing":
        // typing is declared below but this callback only runs once the
        // provider has finished rendering, so the binding is settled by then.
        typing.onTyping(event);
        break;
      case "trace_start":
        traces.startRun(event.runId, event.agentId, event.agentName, event.channelId, event.timestamp);
        break;
      case "trace_chunk":
        traces.appendChunk(event.runId, event.chunk);
        break;
      case "trace_suspended":
        traces.suspendRun(event.runId, event.reason);
        break;
      case "trace_resumed":
        traces.resumeRun(event.runId);
        break;
      case "run_end":
        traces.endRun(event.runId);
        break;
      case "tool_execution":
        setExecutions((prev) => {
          const next = prev.filter((item) => item.id !== event.execution.id);
          return [...next, event.execution];
        });
        break;
      case "demo_progress":
        setDemoProgress(projectDemoProgress(event));
        break;
      case "interaction_request":
        interactions.open(event.request);
        break;
      case "interaction_resolved":
        interactions.close(event.request.id);
        break;
      case "thread_event":
        if (event.event.kind === "resource.access.requested") {
          // Refresh so the UI shows agent/resource names and the new request.
          if (connection.self?.kind === "human") void refreshResourceAccessRequests();
        } else if (event.event.kind === "resource.access.granted" || event.event.kind === "resource.access.denied") {
          const payload = event.event.payload as { requestId: string } | undefined;
          if (payload) {
            setResourceAccessRequests((prev) => prev.filter((r) => r.id !== payload.requestId));
          }
        } else if (event.event.kind === "project.access.requested") {
          if (connection.self?.kind === "human") void refreshProjectAccessRequests();
        } else if (event.event.kind === "project.access.resolved") {
          const payload = event.event.payload as { requestId: string } | undefined;
          if (payload) {
            setProjectAccessRequests((prev) => prev.filter((r) => r.id !== payload.requestId));
          }
        }
        break;
      case "clear":
        chat.clearChannel(event.channel);
        if (event.work && event.channel) board.clearChannel(event.channel);
        break;
      case "error":
        if (event.error === "unauthenticated") {
          onAuthRejected?.();
          break;
        }
        console.warn("[server]", event.error);
        pushToast(event.error);
        break;
    }
  });

  const [agentInvites, setAgentInvites] = useState<AgentSummary[]>([]);

  /** Re-fetch the agent list; runtime health/effectiveModel only change here,
   *  the server does not push them, so callers that need fresh runtime state
   *  (the pairing/profile UI) re-call this on a timer while they're open. */
  const refreshAgents = async (): Promise<void> => {
    const request = api.fetch("/api/agents");
    if (!request) return;
    try {
      const res = await request;
      if (!res.ok) return;
      const data = (await res.json()) as { agents: AgentSummary[] };
      setAgentInvites(data.agents);
    } catch (err) {
      console.warn("[workspace] failed to load agent invites:", err);
    }
  };

  const refreshResourceAccessRequests = async (): Promise<void> => {
    const request = api.fetch("/api/resource-access-requests");
    if (!request) return;
    try {
      const res = await request;
      if (!res.ok) return;
      const data = (await res.json()) as { requests: AgentResourceAccessRequest[] };
      setResourceAccessRequests(data.requests);
    } catch (err) {
      console.warn("[workspace] failed to load resource access requests:", err);
    }
  };

  const resolveResourceAccessRequest = async (requestId: string, decision: "approved" | "denied"): Promise<boolean> => {
    // Optimistically remove the card so the UI feels immediate; the server
    // response and the thread event will reconcile if anything goes wrong.
    setResourceAccessRequests((prev) => prev.filter((r) => r.id !== requestId));
    const request = api.fetch(`/api/agent-context/access-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not ${decision} access request: ${await api.errorMessage(res)}`);
        await refreshResourceAccessRequests();
        return false;
      }
      await refreshResourceAccessRequests();
      return true;
    } catch (err) {
      pushToast(`Could not ${decision} access request: ${String(err)}`);
      await refreshResourceAccessRequests();
      return false;
    }
  };

  const refreshProjectAccessRequests = async (): Promise<void> => {
    const request = api.fetch("/api/project-access-requests");
    if (!request) return;
    try {
      const res = await request;
      if (!res.ok) return;
      const data = (await res.json()) as { requests: ProjectAccessRequest[] };
      setProjectAccessRequests(data.requests);
    } catch (err) {
      console.warn("[workspace] failed to load project access requests:", err);
    }
  };

  const resolveProjectAccessRequest = async (requestId: string, decision: "approved" | "denied"): Promise<boolean> => {
    setProjectAccessRequests((prev) => prev.filter((r) => r.id !== requestId));
    const request = api.fetch(`/api/project-access-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not ${decision} access request: ${await api.errorMessage(res)}`);
        await refreshProjectAccessRequests();
        return false;
      }
      await refreshProjectAccessRequests();
      return true;
    } catch (err) {
      pushToast(`Could not ${decision} access request: ${String(err)}`);
      await refreshProjectAccessRequests();
      return false;
    }
  };

  useEffect(() => {
    if (!connection.self) return;
    void refreshAgents();
    if (connection.self.kind === "human") {
      void refreshResourceAccessRequests();
      void refreshProjectAccessRequests();
    }
  }, [connection.self]);

  const typing = useTyping(connection.self?.id, (channel) =>
    connection.send({ type: "typing", channel }),
  );

  const baseTitle = connection.workspace
    ? `${connection.workspace.name} | convyio`
    : "convyio";
  const unreads = useUnreads(chat.messages, credentials.workspaceId, baseTitle);

  const createChannel = async (name: string, sectionId?: string | null): Promise<string | null> => {
    const request = api.fetch("/api/channels", {
      method: "POST",
      body: JSON.stringify({ name, ...(sectionId ? { sectionId } : {}) }),
    });
    if (!request) return null;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not create the channel: ${await api.errorMessage(res)}`);
        return null;
      }
      const data = (await res.json()) as { channel: { name: string } };
      return data.channel.name;
    } catch (err) {
      pushToast(`Could not create the channel: ${String(err)}`);
      return null;
    }
  };

  /** Shared PATCH/DELETE caller for the channel actions below: same
   *  request/error shape as createChannel, only the verb+body differ. */
  const patchChannel = async (
    name: string,
    body: { name?: string; archived?: boolean; pinned?: boolean; sectionId?: string | null },
    verb: string,
  ): Promise<string | null> => {
    const request = api.fetch(`/api/channels/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (!request) return null;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not ${verb} the channel: ${await api.errorMessage(res)}`);
        return null;
      }
      const data = (await res.json()) as { channel: { name: string } };
      return data.channel.name;
    } catch (err) {
      pushToast(`Could not ${verb} the channel: ${String(err)}`);
      return null;
    }
  };

  const renameChannel = (name: string, newName: string) =>
    patchChannel(name, { name: newName }, "rename");
  const archiveChannel = async (name: string, archived: boolean): Promise<boolean> =>
    (await patchChannel(name, { archived }, archived ? "archive" : "unarchive")) !== null;
  const pinChannel = async (name: string, pinned: boolean): Promise<boolean> =>
    (await patchChannel(name, { pinned }, pinned ? "pin" : "unpin")) !== null;
  const moveChannel = async (name: string, sectionId: string | null): Promise<boolean> =>
    (await patchChannel(name, { sectionId }, "move")) !== null;

  const createChannelSection = async (name: string): Promise<ChannelSection | null> => {
    const request = api.fetch("/api/channel-sections", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (!request) return null;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not create the section: ${await api.errorMessage(res)}`);
        return null;
      }
      const data = (await res.json()) as { section: ChannelSection };
      return data.section;
    } catch (err) {
      pushToast(`Could not create the section: ${String(err)}`);
      return null;
    }
  };

  const deleteChannel = async (name: string): Promise<boolean> => {
    const request = api.fetch(`/api/channels/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not delete the channel: ${await api.errorMessage(res)}`);
        return false;
      }
      return true;
    } catch (err) {
      pushToast(`Could not delete the channel: ${String(err)}`);
      return false;
    }
  };

  /** Resolves false when there's no more history (an empty page, or the request failed). */
  const loadOlder = async (channel: string): Promise<boolean> => {
    const inChannel = chat.messages.filter(
      (m) => (m.channel ?? "general") === channel,
    );
    const oldest = inChannel.reduce(
      (min, m) => (m.timestamp < min ? m.timestamp : min),
      Infinity,
    );
    const before = Number.isFinite(oldest) ? oldest : Date.now();
    const request = api.fetch(
      `/api/messages?channel=${encodeURIComponent(channel)}&before=${before}&limit=50`,
    );
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not load older messages: ${await api.errorMessage(res)}`);
        return false;
      }
      const data = (await res.json()) as { messages: ChatMessage[] };
      if (data.messages.length === 0) return false;
      chat.prepend(data.messages);
      return true;
    } catch (err) {
      pushToast(`Could not load older messages: ${String(err)}`);
      return false;
    }
  };

  const createAgent = async (fields: {
    name: string;
    provider: AgentProvider;
    instructions?: string;
    model?: string | null;
    access?: AgentAccessPolicy;
  }): Promise<{ id: string; pairingCode: string } | null> => {
    const request = api.fetch("/api/agents", {
      method: "POST",
      body: JSON.stringify(fields),
    });
    if (!request) return null;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not add the agent: ${await api.errorMessage(res)}`);
        return null;
      }
      // The response also carries `token` (the agent's own join secret) and
      // `pairing`; neither is surfaced to the UI — only the pairing code is,
      // and only until it's consumed by `convyio-agent pair`.
      const data = (await res.json()) as AgentInvite & { token: string; pairingCode: string };
      setAgentInvites((prev) => [
        {
          ...data,
          runtime: { connected: false, health: "checking", configRevision: data.configRevision, options: [] },
        },
        ...prev,
      ]);
      return { id: data.id, pairingCode: data.pairingCode };
    } catch (err) {
      pushToast(`Could not add the agent: ${String(err)}`);
      return null;
    }
  };

  const updateAgent = async (
    id: string,
    fields: { instructions?: string; model?: string | null; access?: AgentAccessPolicy },
  ): Promise<boolean> => {
    const request = api.fetch(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not update the agent: ${await api.errorMessage(res)}`);
        return false;
      }
      // PATCH returns the invite only (no runtime); keep whatever runtime
      // state this agent already had in the list.
      const updated = (await res.json()) as AgentInvite;
      setAgentInvites((prev) => prev.map((a) => (a.id === id ? { ...a, ...updated } : a)));
      return true;
    } catch (err) {
      pushToast(`Could not update the agent: ${String(err)}`);
      return false;
    }
  };

  const repairAgent = async (id: string): Promise<string | null> => {
    const request = api.fetch(`/api/agents/${encodeURIComponent(id)}/pairings`, {
      method: "POST",
    });
    if (!request) return null;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not create a new pairing code: ${await api.errorMessage(res)}`);
        return null;
      }
      const data = (await res.json()) as { pairingCode: string };
      return data.pairingCode;
    } catch (err) {
      pushToast(`Could not create a new pairing code: ${String(err)}`);
      return null;
    }
  };

  const revokeAgent = async (id: string): Promise<boolean> => {
    const request = api.fetch(`/api/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not remove the agent: ${await api.errorMessage(res)}`);
        return false;
      }
      setAgentInvites((prev) => prev.filter((a) => a.id !== id));
      return true;
    } catch (err) {
      pushToast(`Could not remove the agent: ${String(err)}`);
      return false;
    }
  };

  const restoreNoodle = async (): Promise<boolean> => {
    const request = api.fetch("/api/workspace/noodle", { method: "POST" });
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not restore noodle: ${await api.errorMessage(res)}`);
        return false;
      }
      return true;
    } catch (err) {
      pushToast(`Could not restore noodle: ${String(err)}`);
      return false;
    }
  };

  const removeMember = async (actorId: string): Promise<boolean> => {
    const request = api.fetch(`/api/actors/${encodeURIComponent(actorId)}`, {
      method: "DELETE",
    });
    if (!request) return false;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not remove them from the workspace: ${await api.errorMessage(res)}`);
        return false;
      }
      return true;
    } catch (err) {
      pushToast(`Could not remove them from the workspace: ${String(err)}`);
      return false;
    }
  };

  // Not memoized on purpose: all workspace state lives in the hooks above, so
  // this component only re-renders when the value would change anyway.
  const value: WorkspaceState = {
    workspaceId: credentials.workspaceId,
    workspace: connection.workspace,
    self: connection.self,
    participants: connection.participants,
    channels: connection.channels,
    channelInfos: connection.channelInfos,
    archivedChannels: connection.archivedChannels,
    pinnedChannels: connection.pinnedChannels,
    channelSections: connection.channelSections,
    demoChannels: connection.demoChannels,
    connected: connection.connected,
    messages: chat.messages,
    activeRuns: traces.activeRuns,
    executions,
    runDurations: traces.runDurations,
    demoProgress,
    board: board.items,
    plans: board.plans,
    context: board.context,
    boardLines: board.lines,
    toasts,
    dismissToast,
    notify: pushToast,
    sendMessage: (content, channel, attachmentIds, replyToId) => {
      if (!connection.self) return;
      chat.sendMessage(
        {
          authorId: connection.self.id,
          authorName: connection.self.name,
          authorKind: connection.self.kind,
          content,
          channel,
          replyToId,
        },
        (nonce) => {
          const frame: ClientEvent = {
            type: "message",
            content,
            channel,
            attachmentIds:
              attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
            replyToId,
            nonce,
          };
          pendingFramesRef.current.set(nonce, frame);
          return connection.send(frame);
        },
      );
    },
    retryMessage: (nonce) => {
      const frame = pendingFramesRef.current.get(nonce);
      if (!frame) return;
      chat.retry(nonce, () => connection.send(frame));
    },
    discardMessage: (nonce) => {
      pendingFramesRef.current.delete(nonce);
      chat.discard(nonce);
    },
    editMessage: (messageId, content) =>
      connection.send({ type: "message_edit", messageId, content }),
    deleteMessage: (messageId) =>
      connection.send({ type: "message_delete", messageId }),
    reactToMessage: (messageId, emoji, op) =>
      connection.send({ type: "message_react", messageId, emoji, op }),
    sendTyping: typing.sendTyping,
    typistsIn: typing.typistsIn,
    unreadCount: unreads.unreadCount,
    firstUnreadId: unreads.firstUnreadId,
    markRead: unreads.markRead,
    loadOlder,
    pinMessage: (messageId, pinned) =>
      connection.send({ type: "pin", messageId, pinned }),
    attachmentDraftsFor: attachments.draftsFor,
    addAttachments: attachments.add,
    removeAttachment: attachments.remove,
    takeReadyAttachmentIds: attachments.takeReadyIds,
    uploadAttachment: attachments.uploadNow,
    attachmentUrl: (attachment) => api.url(attachment.url),
    pendingInteractions: interactions.pending.filter(
      (request) => !request.targetActorId || request.targetActorId === connection.self?.id,
    ),
    resolveInteraction: (requestId, decision) =>
      connection.send({ type: "interaction_resolve", requestId, decision }),
    pendingResourceAccessRequests: resourceAccessRequests,
    resolveResourceAccessRequest,
    pendingProjectAccessRequests: projectAccessRequests,
    resolveProjectAccessRequest,
    setPermissionMode: (agentId, channel, mode) =>
      connection.send({ type: "conversation_mode_set", agentId, channel, mode }),
    setStatus: (status) => connection.send({ type: "status_set", status }),
    signOut: onSignOut ?? null,
    clearMessages: () => connection.send({ type: "clear" }),
    interrupt: (target, content) =>
      connection.send({ type: "interrupt", target, content }),
    startDemo: (channel, mode) => connection.send({ type: "demo_start", channel, mode }),
    demoControl: (channel, action) => connection.send({ type: "demo_control", channel, action }),
    createChannel,
    renameChannel,
    archiveChannel,
    pinChannel,
    deleteChannel,
    createChannelSection,
    moveChannel,
    createBoardItem: board.createItem,
    createPlan: board.createPlan,
    addPlanConstraint: board.addPlanConstraint,
    acceptPlan: board.acceptPlan,
    approveItem: board.approve,
    denyItem: board.deny,
    startItem: board.start,
    completeItem: board.complete,
    reopenItem: board.reopen,
    deleteItem: board.deleteItem,
    editItem: board.editItem,
    fetchActors: board.fetchActors,
    fetchItemEvents: board.fetchItemEvents,
    agentInvites,
    // Empty until the welcome frame lands; the page's own origin is the
    // production server anyway, and a blank --server would paste a broken
    // pairing command.
    apiUrl: api.url("") || window.location.origin,
    apiFetch: api.fetch,
    createAgent,
    updateAgent,
    repairAgent,
    revokeAgent,
    setAgentActive: (actorId, active) =>
      connection.send({ type: "agent_activate", target: actorId, active }),
    restoreNoodle,
    refreshAgents,
    removeMember,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
