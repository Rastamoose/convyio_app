import { useRef, useState } from "react";
import type { TraceChunk } from "@workspace/shared";

/** A live agent run whose trace is still streaming in. */
export interface ActiveRun {
  runId: string;
  agentName: string;
  chunks: TraceChunk[];
  startedAt: number;
}

/**
 * Agent run traces: live runs with streaming chunks, and how long each
 * finished run took (keyed by runId, for "Worked for Ns" on its message).
 */
export function useAgentTraces() {
  const startTimes = useRef(new Map<string, number>());
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [runDurations, setRunDurations] = useState<Map<string, number>>(
    new Map(),
  );

  return {
    activeRuns,
    runDurations,
    reset: () => {
      startTimes.current.clear();
      setActiveRuns([]);
      setRunDurations(new Map());
    },
    startRun: (runId: string, agentName: string, timestamp: number) => {
      startTimes.current.set(runId, timestamp);
      setActiveRuns((prev) => {
        if (prev.some((r) => r.runId === runId)) return prev;
        return [...prev, { runId, agentName, chunks: [], startedAt: timestamp }];
      });
    },
    appendChunk: (runId: string, chunk: TraceChunk) => {
      setActiveRuns((prev) =>
        prev.map((r) =>
          r.runId === runId ? { ...r, chunks: [...r.chunks, chunk] } : r,
        ),
      );
    },
    /** run_end without a summary message: drop the run, record nothing. */
    endRun: (runId: string) => {
      startTimes.current.delete(runId);
      setActiveRuns((prev) => prev.filter((r) => r.runId !== runId));
    },
    /** A summary message arrived for the run: record its duration. */
    completeRun: (runId: string) => {
      const startedAt = startTimes.current.get(runId);
      if (startedAt != null) {
        setRunDurations((durations) => {
          const next = new Map(durations);
          next.set(runId, Date.now() - startedAt);
          return next;
        });
        startTimes.current.delete(runId);
      }
      setActiveRuns((prev) => prev.filter((r) => r.runId !== runId));
    },
  };
}
