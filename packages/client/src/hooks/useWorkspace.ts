import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Actor,
  BoardEventEnvelope,
  BoardItem,
  BoardItemEvent,
  ChatMessage,
  ItemStatus,
  Participant,
  ParticipantKind,
  RunState,
  TraceChunk,
} from "@workspace/shared";
import { WorkspaceSocket } from "../ws";
import { AGENT_NAME, getLocalScript, runLocalDemo } from "../demo";

const runStartTimes = new Map<string, number>();

export interface ActiveRun {
  runId: string;
  agentName: string;
  chunks: TraceChunk[];
  startedAt: number;
}

/** Compact system line derived from a board event, interleaved into chat. */
export interface BoardLine {
  id: string;
  ts: number;
  text: string;
}

export interface BoardItemEdit {
  title?: string;
  description?: string;
  owner?: string | null;
}

export interface WorkspaceState {
  self: Participant | null;
  messages: ChatMessage[];
  participants: Participant[];
  activeRuns: ActiveRun[];
  runDurations: Map<string, number>;
  board: BoardItem[];
  boardLines: BoardLine[];
  connected: boolean;
  sendMessage: (content: string, channel?: string) => void;
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
  setStatus: (status: string) => void;
  clearMessages: () => void;
  interrupt: (target: string, content: string) => void;
  startDemo: (channel: string) => void;
}

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001";

function createLocalSelf(name: string): Participant {
  return {
    id: crypto.randomUUID(),
    name,
    kind: "human",
    status: "",
    runState: "idle",
    online: true,
  };
}

function boardLineText(envelope: BoardEventEnvelope): string | null {
  const actor = envelope.actor.display_name;
  const ref = envelope.item.ref;
  switch (envelope.type) {
    case "item.proposed":
      return `${actor} proposed ${ref} — "${envelope.item.title}"`;
    case "item.approved":
      return `${actor} approved ${ref}`;
    case "item.denied":
      return `${actor} denied ${ref}`;
    case "item.completed":
      return `${actor} completed ${ref}`;
    case "item.deleted":
      return `${actor} deleted ${ref}`;
    default:
      return null;
  }
}

export function useWorkspace(name: string | null): WorkspaceState {
  const socketRef = useRef<WorkspaceSocket | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const syntheticIds = useRef(new Map<string, string>());
  const demoCancelRef = useRef<(() => void) | null>(null);
  const standaloneRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const apiUrlRef = useRef<string | null>(null);

  const [self, setSelf] = useState<Participant | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [runDurations, setRunDurations] = useState<Map<string, number>>(
    new Map(),
  );
  const [board, setBoard] = useState<BoardItem[]>([]);
  const [boardLines, setBoardLines] = useState<BoardLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [standalone, setStandalone] = useState(false);

  const activateStandalone = (displayName: string) => {
    if (standaloneRef.current) return;
    standaloneRef.current = true;
    setStandalone(true);

    const localSelf = createLocalSelf(displayName);
    selfIdRef.current = localSelf.id;
    syntheticIds.current.set(
      `human:${displayName.toLowerCase()}`,
      localSelf.id,
    );

    setSelf(localSelf);
    setParticipants([localSelf]);
    setConnected(true);
  };

  const apiFetch = (
    path: string,
    init?: RequestInit,
  ): Promise<Response> | null => {
    const token = tokenRef.current;
    const apiUrl = apiUrlRef.current;
    if (!token || !apiUrl) return null;
    return fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  };

  const upsertBoardItem = (item: BoardItem) => {
    setBoard((prev) => {
      if (item.deletedAt != null) return prev.filter((i) => i.id !== item.id);
      return prev.some((i) => i.id === item.id)
        ? prev.map((i) => (i.id === item.id ? item : i))
        : [item, ...prev];
    });
  };

  const applyBoardEvent = (envelope: BoardEventEnvelope) => {
    upsertBoardItem(envelope.item);
    const text = boardLineText(envelope);
    if (text) {
      setBoardLines((prev) => [
        ...prev,
        { id: crypto.randomUUID(), ts: Date.parse(envelope.ts), text },
      ]);
    }
  };

  const loadBoard = (apiUrl: string, token: string) => {
    void fetch(`${apiUrl}/api/board/items?include_deleted=true`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`board fetch failed: ${res.status}`);
        return res.json() as Promise<{ items: BoardItem[] }>;
      })
      .then(({ items }) => setBoard(items.filter((i) => i.deletedAt == null)))
      .catch((err) => console.warn("[board]", err));
  };

  const ensureParticipant = (
    participantName: string,
    kind: ParticipantKind,
    status = "",
  ): string => {
    const key = `${kind}:${participantName.toLowerCase()}`;
    let id = syntheticIds.current.get(key);
    if (!id) {
      id = crypto.randomUUID();
      syntheticIds.current.set(key, id);
    }
    setParticipants((prev) =>
      prev.some((p) => p.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              name: participantName,
              kind,
              status,
              runState: "idle",
              online: true,
            },
          ],
    );
    return id;
  };

  const postLocalMessage = (
    authorId: string,
    authorName: string,
    authorKind: ParticipantKind,
    content: string,
    channel = "general",
  ) => {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      authorId,
      authorName,
      authorKind,
      content,
      timestamp: Date.now(),
      channel,
    };
    setMessages((prev) => [...prev, message]);
  };

  const setParticipantState = (
    participantName: string,
    kind: ParticipantKind,
    runState: RunState,
    status?: string,
  ) => {
    setParticipants((prev) =>
      prev.map((p) =>
        p.kind === kind && p.name.toLowerCase() === participantName.toLowerCase()
          ? { ...p, runState, ...(status !== undefined ? { status } : {}) }
          : p,
      ),
    );
  };

  const startLocalDemo = (channel: string) => {
    demoCancelRef.current?.();
    const script = getLocalScript(channel);
    if (!script) return;

    // Clear the demo channel before replaying.
    setMessages((prev) =>
      prev.filter((m) => (m.channel ?? "general") !== channel),
    );

    const personaIds = new Map<string, string>();
    for (const persona of script.personas) {
      personaIds.set(persona.toLowerCase(), ensureParticipant(persona, "human"));
    }
    const agentId = ensureParticipant(AGENT_NAME, "agent");

    const cancel = runLocalDemo(channel, {
      onPost: (kind, authorName, content) => {
        const id =
          kind === "agent"
            ? agentId
            : (personaIds.get(authorName.toLowerCase()) ??
              ensureParticipant(authorName, "human"));
        postLocalMessage(id, authorName, kind, content, channel);
      },
      onAgentStart: (status) => {
        setParticipantState(AGENT_NAME, "agent", "working", status);
      },
      onAgentDone: () => {
        setParticipantState(AGENT_NAME, "agent", "idle", "");
      },
      onBoardLine: (text) => {
        setBoardLines((prev) => [
          ...prev,
          { id: crypto.randomUUID(), ts: Date.now(), text },
        ]);
      },
      onBoardItem: upsertBoardItem,
      onFinished: (personas) => {
        // Remove the synthetic human personas; leave the agent around.
        const lower = personas.map((p) => p.toLowerCase());
        setParticipants((prev) =>
          prev.filter(
            (p) => !(p.kind === "human" && lower.includes(p.name.toLowerCase())),
          ),
        );
      },
    });

    demoCancelRef.current = cancel;
  };

  useEffect(() => {
    if (!name) return;

    // If the build is using the default localhost websocket and this page is
    // being served from somewhere that is not localhost, we know the server
    // cannot be reached. Switch to a self-contained browser demo immediately.
    const isDefaultLocalhost =
      !import.meta.env.VITE_WS_URL && WS_URL.includes("//localhost");
    const onRemoteHost = window.location.hostname !== "localhost";

    if (isDefaultLocalhost && onRemoteHost) {
      activateStandalone(name);
      return;
    }

    const socket = new WorkspaceSocket();
    socketRef.current = socket;

    let fallbackTimer: number | null = null;

    const unsubscribe = socket.onEvent((event) => {
      // Board events arrive as envelopes on the same socket.
      if ("item" in event && event.channel === "board") {
        applyBoardEvent(event);
        return;
      }
      switch (event.type) {
        case "welcome": {
          if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
          setSelf(event.self);
          selfIdRef.current = event.self.id;
          tokenRef.current = event.token;
          apiUrlRef.current = event.apiUrl;
          setMessages(event.history);
          setActiveRuns([]);
          setRunDurations(new Map());
          setParticipants(event.participants);
          setBoardLines([]);
          setConnected(true);
          loadBoard(event.apiUrl, event.token);
          break;
        }
        case "message": {
          const { message } = event;
          setMessages((prev) => [...prev, message]);
          if (message.runId) {
            const runId = message.runId;
            const startedAt = runStartTimes.get(runId);
            if (startedAt != null) {
              setRunDurations((durations) => {
                const next = new Map(durations);
                next.set(runId, Date.now() - startedAt);
                return next;
              });
              runStartTimes.delete(runId);
            }
            setActiveRuns((runs) => runs.filter((r) => r.runId !== runId));
          }
          break;
        }
        case "presence_sync":
          setParticipants(event.participants);
          break;
        case "trace_start":
          runStartTimes.set(event.runId, event.timestamp);
          setActiveRuns((prev) => {
            if (prev.some((r) => r.runId === event.runId)) return prev;
            return [
              ...prev,
              {
                runId: event.runId,
                agentName: event.agentName,
                chunks: [],
                startedAt: event.timestamp,
              },
            ];
          });
          break;
        case "trace_chunk":
          setActiveRuns((prev) =>
            prev.map((r) =>
              r.runId === event.runId
                ? { ...r, chunks: [...r.chunks, event.chunk] }
                : r,
            ),
          );
          break;
        case "run_end":
          setActiveRuns((prev) => prev.filter((r) => r.runId !== event.runId));
          runStartTimes.delete(event.runId);
          break;
        case "clear":
          if (event.channel) {
            const cleared = event.channel;
            setMessages((prev) =>
              prev.filter((m) => (m.channel ?? "general") !== cleared),
            );
          } else {
            setMessages([]);
          }
          break;
        case "error":
          console.warn("[server]", event.error);
          break;
      }
    });

    socket.connect(name);

    // If the server doesn't welcome us within a few seconds, fall back to
    // a purely client-side workspace so the demo still works on static hosts.
    fallbackTimer = window.setTimeout(() => {
      if (!connected) {
        socket.close();
        activateStandalone(name);
      }
    }, 2500);

    return () => {
      if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
      unsubscribe();
      socket.close();
    };
  }, [name]);

  return useMemo(() => {
    /** Optimistically set a status, POST a transition, and roll back on failure. */
    const transitionItem = (
      itemId: string,
      action: string,
      status: ItemStatus,
      body?: unknown,
    ) => {
      if (standaloneRef.current) return;
      const previous = board.find((i) => i.id === itemId);
      if (!previous) return;
      setBoard((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, status } : i)),
      );
      const rollback = () =>
        setBoard((prev) => prev.map((i) => (i.id === itemId ? previous : i)));
      const request = apiFetch(`/api/board/items/${itemId}/${action}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!request) return;
      void request
        .then(async (res) => {
          if (res.ok) return;
          const err = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          console.warn("[board]", err?.message ?? `request failed: ${res.status}`);
          rollback();
        })
        .catch((err) => {
          console.warn("[board]", err);
          rollback();
        });
    };

    return {
      self,
      messages,
      participants,
      activeRuns,
      runDurations,
      board,
      boardLines,
      connected,
      sendMessage: (content: string, channel?: string) => {
        if (standaloneRef.current) {
          const selfId = selfIdRef.current;
          if (!selfId || !name) return;
          postLocalMessage(
            selfId,
            name,
            "human",
            content,
            channel ?? "general",
          );
          return;
        }
        socketRef.current?.send({ type: "message", content, channel });
      },
      createBoardItem: (title: string, description?: string) => {
        if (standaloneRef.current) return;
        const request = apiFetch("/api/board/items", {
          method: "POST",
          body: JSON.stringify({ title, description }),
        });
        if (!request) return;
        void request
          .then(async (res) => {
            const data = (await res.json().catch(() => null)) as {
              item?: BoardItem;
              message?: string;
            } | null;
            if (!res.ok) {
              console.warn(
                "[board]",
                data?.message ?? `request failed: ${res.status}`,
              );
              return;
            }
            if (data?.item) upsertBoardItem(data.item);
          })
          .catch((err) => console.warn("[board]", err));
      },
      approveItem: (itemId: string) => {
        transitionItem(itemId, "approve", "approved");
      },
      denyItem: (itemId: string) => {
        transitionItem(itemId, "deny", "denied", {});
      },
      startItem: (itemId: string) => {
        transitionItem(itemId, "start", "in_progress");
      },
      completeItem: (itemId: string) => {
        transitionItem(itemId, "complete", "done");
      },
      reopenItem: (itemId: string) => {
        transitionItem(itemId, "reopen", "approved");
      },
      deleteItem: (itemId: string) => {
        if (standaloneRef.current) return;
        const previous = board.find((i) => i.id === itemId);
        if (!previous) return;
        setBoard((prev) => prev.filter((i) => i.id !== itemId));
        const restore = () =>
          setBoard((prev) =>
            prev.some((i) => i.id === itemId) ? prev : [previous, ...prev],
          );
        const request = apiFetch(`/api/board/items/${itemId}`, {
          method: "DELETE",
        });
        if (!request) return;
        void request
          .then(async (res) => {
            if (res.ok) return;
            const err = (await res.json().catch(() => null)) as {
              message?: string;
            } | null;
            console.warn(
              "[board]",
              err?.message ?? `request failed: ${res.status}`,
            );
            restore();
          })
          .catch((err) => {
            console.warn("[board]", err);
            restore();
          });
      },
      editItem: (itemId: string, fields: BoardItemEdit) => {
        if (standaloneRef.current) return;
        const previous = board.find((i) => i.id === itemId);
        if (!previous) return;
        setBoard((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? {
                  ...i,
                  ...(fields.title !== undefined ? { title: fields.title } : {}),
                  ...(fields.description !== undefined
                    ? { description: fields.description }
                    : {}),
                  ...(fields.owner !== undefined
                    ? {
                        owner: fields.owner,
                        ownerName: fields.owner == null ? undefined : i.ownerName,
                      }
                    : {}),
                }
              : i,
          ),
        );
        const rollback = () =>
          setBoard((prev) => prev.map((i) => (i.id === itemId ? previous : i)));
        const request = apiFetch(`/api/board/items/${itemId}`, {
          method: "PATCH",
          body: JSON.stringify(fields),
        });
        if (!request) return;
        void request
          .then(async (res) => {
            const data = (await res.json().catch(() => null)) as {
              item?: BoardItem;
              message?: string;
            } | null;
            if (!res.ok) {
              console.warn(
                "[board]",
                data?.message ?? `request failed: ${res.status}`,
              );
              rollback();
              return;
            }
            if (data?.item) upsertBoardItem(data.item);
          })
          .catch((err) => {
            console.warn("[board]", err);
            rollback();
          });
      },
      fetchActors: async (): Promise<Actor[]> => {
        const request = apiFetch("/api/actors");
        if (!request) return [];
        try {
          const res = await request;
          if (!res.ok) return [];
          const data = (await res.json()) as { actors?: Actor[] };
          return data.actors ?? [];
        } catch (err) {
          console.warn("[board]", err);
          return [];
        }
      },
      fetchItemEvents: async (itemId: string): Promise<BoardItemEvent[]> => {
        const request = apiFetch(`/api/board/items/${itemId}/events`);
        if (!request) return [];
        try {
          const res = await request;
          if (!res.ok) return [];
          const data = (await res.json()) as { events?: BoardItemEvent[] };
          return data.events ?? [];
        } catch (err) {
          console.warn("[board]", err);
          return [];
        }
      },
      setStatus: (status: string) => {
        if (standaloneRef.current) {
          const selfId = selfIdRef.current;
          if (!selfId) return;
          setParticipants((prev) =>
            prev.map((p) =>
              p.id === selfId ? { ...p, status } : p,
            ),
          );
          return;
        }
        socketRef.current?.send({ type: "status_set", status });
      },
      clearMessages: () => {
        if (standaloneRef.current) {
          setMessages([]);
          return;
        }
        socketRef.current?.send({ type: "clear" });
      },
      interrupt: (target: string, content: string) => {
        if (standaloneRef.current) return;
        socketRef.current?.send({ type: "interrupt", target, content });
      },
      startDemo: (channel: string) => {
        if (standaloneRef.current) {
          startLocalDemo(channel);
          return;
        }
        socketRef.current?.send({ type: "demo_start", channel });
      },
    };
  }, [self, messages, participants, activeRuns, runDurations, board, boardLines, connected, name]);
}
