import { createContext, useContext, type ReactNode } from "react";
import type {
  Actor,
  BoardItem,
  BoardItemEvent,
  ChatMessage,
  Participant,
} from "@workspace/shared";
import { isBoardEnvelope } from "@workspace/shared";
import { useConnection } from "./useConnection";
import { useChatMessages } from "./useChatMessages";
import { useAgentTraces, type ActiveRun } from "./useAgentTraces";
import { useApiSession } from "./useApiSession";
import { useBoard, type BoardItemEdit, type BoardLine } from "./useBoard";
import { useToasts, type Toast } from "./useToasts";

export interface WorkspaceState {
  self: Participant | null;
  participants: Participant[];
  channels: string[];
  demoChannels: string[];
  connected: boolean;
  messages: ChatMessage[];
  activeRuns: ActiveRun[];
  runDurations: Map<string, number>;
  board: BoardItem[];
  boardLines: BoardLine[];
  toasts: Toast[];
  dismissToast: (id: number) => void;
  sendMessage: (content: string, channel?: string) => void;
  setStatus: (status: string) => void;
  clearMessages: () => void;
  interrupt: (target: string, content: string) => void;
  startDemo: (channel: string) => void;
  /** Resolves to the created channel's normalized name, or null on failure. */
  createChannel: (name: string) => Promise<string | null>;
  createBoardItem: (title: string, description?: string) => void;
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
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const chat = useChatMessages();
  const traces = useAgentTraces();
  const api = useApiSession();
  const board = useBoard(pushToast, api);

  const connection = useConnection(name, (event) => {
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
    sendMessage: (content, channel) =>
      connection.send({ type: "message", content, channel }),
    setStatus: (status) => connection.send({ type: "status_set", status }),
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
