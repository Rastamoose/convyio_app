import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Participant, TraceChunk } from "@workspace/shared";
import { WorkspaceSocket } from "../ws";

const runStartTimes = new Map<string, number>();

export interface ActiveRun {
  runId: string;
  agentName: string;
  chunks: TraceChunk[];
  startedAt: number;
}

export interface WorkspaceState {
  self: Participant | null;
  messages: ChatMessage[];
  participants: Participant[];
  activeRuns: ActiveRun[];
  runDurations: Map<string, number>;
  connected: boolean;
  sendMessage: (content: string, channel?: string) => void;
  setStatus: (status: string) => void;
  clearMessages: () => void;
  interrupt: (target: string, content: string) => void;
  startDemo: (channel: string) => void;
}

export function useWorkspace(name: string | null): WorkspaceState {
  const socketRef = useRef<WorkspaceSocket | null>(null);
  const [self, setSelf] = useState<Participant | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [runDurations, setRunDurations] = useState<Map<string, number>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!name) return;
    const socket = new WorkspaceSocket();
    socketRef.current = socket;

    const unsubscribe = socket.onEvent((event) => {
      switch (event.type) {
        case "welcome":
          setSelf(event.self);
          setMessages(event.history);
          setActiveRuns([]);
          setRunDurations(new Map());
          setParticipants(event.participants);
          setConnected(true);
          break;
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
    return () => {
      unsubscribe();
      socket.close();
    };
  }, [name]);

  return useMemo(
    () => ({
      self,
      messages,
      participants,
      activeRuns,
      runDurations,
      connected,
      sendMessage: (content: string, channel?: string) =>
        socketRef.current?.send({ type: "message", content, channel }),
      setStatus: (status: string) =>
        socketRef.current?.send({ type: "status_set", status }),
      clearMessages: () => socketRef.current?.send({ type: "clear" }),
      interrupt: (target: string, content: string) =>
        socketRef.current?.send({ type: "interrupt", target, content }),
      startDemo: (channel: string) =>
        socketRef.current?.send({ type: "demo_start", channel }),
    }),
    [self, messages, participants, activeRuns, runDurations, connected],
  );
}
