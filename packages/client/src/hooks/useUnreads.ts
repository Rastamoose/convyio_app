import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@workspace/shared";

const STORAGE_KEY = "convyio:lastRead";

interface UnreadState {
  /** Channel currently being viewed; always reads as zero unread. */
  active: string | null;
  lastRead: Record<string, number>;
  /** First unread message id snapshotted at the moment a channel became active. */
  firstUnread: Record<string, string | null>;
}

const channelOf = (m: ChatMessage) => m.channel ?? "general";

function loadLastRead(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Per-channel unread tracking driven off the chat log. The active channel
 * always reads as zero; switching into a channel snapshots its first unread
 * message (for a "NEW" divider) before marking it read. Keep it simple:
 * unread = messages newer than the channel's last-read stamp — no scroll
 * position modeling.
 */
export function useUnreads(messages: ChatMessage[]) {
  const [state, setState] = useState<UnreadState>(() => ({
    active: null,
    lastRead: loadLastRead(),
    firstUnread: {},
  }));

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.lastRead));
  }, [state.lastRead]);

  const unreadCount = (channel: string): number => {
    if (channel === state.active) return 0;
    const since = state.lastRead[channel] ?? 0;
    return messages.filter((m) => channelOf(m) === channel && m.timestamp > since)
      .length;
  };

  // Captured once, before any "(N) " prefix is ever applied, so restoring
  // at zero unread never bakes in a stale count.
  const baseTitleRef = useRef<string | null>(null);
  if (baseTitleRef.current === null) baseTitleRef.current = document.title;

  const channels = Array.from(new Set(messages.map(channelOf)));
  const total = channels.reduce((sum, c) => sum + unreadCount(c), 0);
  useEffect(() => {
    const base = baseTitleRef.current ?? "";
    document.title = total > 0 ? `(${total}) ${base}` : base;
  }, [total]);

  return {
    unreadCount,
    firstUnreadId: (channel: string): string | null =>
      state.firstUnread[channel] ?? null,
    /** Switching into `channel`: snapshot its first unread message, then mark it read. */
    markRead: (channel: string) => {
      setState((prev) => {
        if (prev.active === channel) return prev;
        const lastRead = { ...prev.lastRead };
        // The channel we're leaving was exempt from unread counting only
        // while active; lock in "read up to now" so it doesn't retroactively
        // count messages that arrived while we were looking at it.
        if (prev.active) lastRead[prev.active] = Date.now();
        const since = prev.lastRead[channel] ?? 0;
        const first = messages.find(
          (m) => channelOf(m) === channel && m.timestamp > since,
        );
        lastRead[channel] = Date.now();
        return {
          active: channel,
          lastRead,
          firstUnread: { ...prev.firstUnread, [channel]: first?.id ?? null },
        };
      });
    },
  };
}
