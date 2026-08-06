import { createContext, useContext, useRef, type ReactNode } from "react";
import type {
  Actor,
  Attachment,
  BoardItem,
  BoardItemEvent,
  ChatMessage,
  ClientEvent,
  Participant,
} from "@workspace/shared";
import { isBoardEnvelope } from "@workspace/shared";
import type { JoinCredentials } from "../ws";
import { useConnection } from "./useConnection";
import { useChatMessages, type LocalMessage } from "./useChatMessages";
import { useAgentTraces, type ActiveRun } from "./useAgentTraces";
import { useApiSession } from "./useApiSession";
import {
  useAttachmentDrafts,
  type AttachmentDraft,
} from "./useAttachmentDrafts";
import { useBoard, type BoardItemEdit, type BoardLine } from "./useBoard";
import { useToasts, type Toast } from "./useToasts";
import { useTyping, type Typist } from "./useTyping";
import { useUnreads } from "./useUnreads";

export interface WorkspaceState {
  self: Participant | null;
  participants: Participant[];
  channels: string[];
  demoChannels: string[];
  connected: boolean;
  messages: LocalMessage[];
  activeRuns: ActiveRun[];
  runDurations: Map<string, number>;
  board: BoardItem[];
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
  /** Displayable absolute URL for an attachment's server-relative url. */
  attachmentUrl: (attachment: Attachment) => string;
  setStatus: (status: string) => void;
  /** Ends the Google session; null in guest mode (nothing to sign out of). */
  signOut: (() => void) | null;
  clearMessages: () => void;
  interrupt: (target: string, content: string) => void;
  startDemo: (channel: string) => void;
  /** Resolves to the created channel's normalized name, or null on failure. */
  createChannel: (name: string) => Promise<string | null>;
  /** Resolves true when the item landed; false = failure (toast already shown). */
  createBoardItem: (title: string, description?: string) => Promise<boolean>;
  approveItem: (itemId: string) => void;
  denyItem: (itemId: string) => void;
  startItem: (itemId: string) => void;
  completeItem: (itemId: string) => void;
  reopenItem: (itemId: string) => void;
  deleteItem: (itemId: string) => void;
  editItem: (itemId: string, fields: BoardItemEdit) => void;
  fetchActors: () => Promise<Actor[]>;
  fetchItemEvents: (itemId: string) => Promise<BoardItemEvent[]>;
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
  const api = useApiSession();
  const attachments = useAttachmentDrafts(pushToast, api);
  const board = useBoard(pushToast, api);
  const unreads = useUnreads(chat.messages);
  // Frames stashed by nonce so retry() can re-send the exact same content;
  // cleared once the send resolves (echo) or is discarded.
  const pendingFramesRef = useRef(new Map<string, ClientEvent>());

  const connection = useConnection(credentials, (event) => {
    if (isBoardEnvelope(event)) {
      board.applyEnvelope(event);
      return;
    }
    switch (event.type) {
      case "welcome":
        chat.replaceAll(event.history);
        traces.reset();
        // The session must be bound before the board loads its snapshot.
        api.start(event.apiUrl, event.token);
        board.startSession();
        break;
      case "message":
        chat.append(event.message);
        if (event.message.runId) traces.completeRun(event.message.runId);
        break;
      case "message_updated":
        chat.update(event.message);
        break;
      case "trace_start":
        traces.startRun(event.runId, event.agentName, event.timestamp);
        break;
      case "trace_chunk":
        traces.appendChunk(event.runId, event.chunk);
        break;
      case "run_end":
        traces.endRun(event.runId);
        break;
      case "clear":
        chat.clearChannel(event.channel);
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

  const createChannel = async (name: string): Promise<string | null> => {
    const request = api.fetch("/api/channels", {
      method: "POST",
      body: JSON.stringify({ name }),
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

  // Not memoized on purpose: all workspace state lives in the hooks above, so
  // this component only re-renders when the value would change anyway.
  const value: WorkspaceState = {
    self: connection.self,
    participants: connection.participants,
    channels: connection.channels,
    demoChannels: connection.demoChannels,
    connected: connection.connected,
    messages: chat.messages,
    activeRuns: traces.activeRuns,
    runDurations: traces.runDurations,
    board: board.items,
    boardLines: board.lines,
    toasts,
    dismissToast,
    notify: pushToast,
    sendMessage: (content, channel, attachmentIds) =>
      connection.send({
        type: "message",
        content,
        channel,
        attachmentIds:
          attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
      }),
    pinMessage: (messageId, pinned) =>
      connection.send({ type: "pin", messageId, pinned }),
    attachmentDraftsFor: attachments.draftsFor,
    addAttachments: attachments.add,
    removeAttachment: attachments.remove,
    takeReadyAttachmentIds: attachments.takeReadyIds,
    attachmentUrl: (attachment) => api.url(attachment.url),
    setStatus: (status) => connection.send({ type: "status_set", status }),
    signOut: onSignOut ?? null,
    clearMessages: () => connection.send({ type: "clear" }),
    interrupt: (target, content) =>
      connection.send({ type: "interrupt", target, content }),
    startDemo: (channel) => connection.send({ type: "demo_start", channel }),
    createChannel,
    createBoardItem: board.createItem,
    approveItem: board.approve,
    denyItem: board.deny,
    startItem: board.start,
    completeItem: board.complete,
    reopenItem: board.reopen,
    deleteItem: board.deleteItem,
    editItem: board.editItem,
    fetchActors: board.fetchActors,
    fetchItemEvents: board.fetchItemEvents,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
