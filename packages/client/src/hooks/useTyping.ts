import { useEffect, useRef, useState } from "react";
import type { TypingBroadcast } from "@workspace/shared";

export interface Typist {
  actorId: string;
  name: string;
  at: number;
}

/** Entries older than this (since their last signal) are pruned. */
const EXPIRE_MS = 6_000;
/** Outbound typing signals are throttled to at most one per channel this often. */
const THROTTLE_MS = 3_000;
const PRUNE_INTERVAL_MS = 1_000;

/**
 * Live "X is typing…" state per channel, fed by `typing` broadcasts and
 * pruned on a single interval (not a timer per typist) so stale entries
 * silently expire. `sendTyping` throttles the outbound signal client-side
 * so held-down keys don't flood the socket.
 */
export function useTyping(
  selfId: string | undefined,
  send: (channel: string) => boolean,
) {
  const [byChannel, setByChannel] = useState<Record<string, Typist[]>>({});
  const lastSentRef = useRef(new Map<string, number>());

  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - EXPIRE_MS;
      setByChannel((prev) => {
        let changed = false;
        const next: Record<string, Typist[]> = {};
        for (const [channel, typists] of Object.entries(prev)) {
          const fresh = typists.filter((t) => t.at >= cutoff);
          if (fresh.length !== typists.length) changed = true;
          if (fresh.length > 0) next[channel] = fresh;
        }
        return changed ? next : prev;
      });
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return {
    typistsIn: (channel: string): Typist[] => byChannel[channel] ?? [],
    /** A `typing` broadcast arrived; self is never recorded. */
    onTyping: (event: TypingBroadcast) => {
      if (event.actorId === selfId) return;
      setByChannel((prev) => {
        const existing = prev[event.channel] ?? [];
        const entry: Typist = {
          actorId: event.actorId,
          name: event.name,
          at: event.timestamp,
        };
        const next = existing.some((t) => t.actorId === event.actorId)
          ? existing.map((t) => (t.actorId === event.actorId ? entry : t))
          : [...existing, entry];
        return { ...prev, [event.channel]: next };
      });
    },
    /** Throttled outbound signal: at most one `typing` frame per ~3s per channel. */
    sendTyping: (channel: string) => {
      const now = Date.now();
      const last = lastSentRef.current.get(channel) ?? 0;
      if (now - last < THROTTLE_MS) return;
      lastSentRef.current.set(channel, now);
      send(channel);
    },
  };
}
