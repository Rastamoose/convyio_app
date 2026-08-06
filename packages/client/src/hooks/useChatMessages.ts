import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@workspace/shared";

/**
 * Client-only optimistic-send state; never goes on the wire and is never
 * part of the shared ChatMessage protocol type.
 */
export type LocalMessage = ChatMessage & {
  pending?: true;
  failed?: true;
  nonce?: string;
};

/** What the caller knows before the server assigns an id. */
export type MessageDraft = Pick<
  ChatMessage,
  "authorId" | "authorName" | "authorKind" | "content"
> &
  Partial<Pick<ChatMessage, "channel" | "attachments" | "replyToId">>;

/** No echo within this window means the send is presumed lost. */
const SEND_TIMEOUT_MS = 10_000;

/** Chat message log: history replacement on welcome, appends, in-place updates, clears. */
export function useChatMessages() {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
    },
    [],
  );

  const clearTimer = (nonce: string) => {
    const timer = timersRef.current.get(nonce);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(nonce);
    }
  };

  const armTimeout = (nonce: string) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(nonce);
      setMessages((prev) =>
        prev.map((m) =>
          m.nonce === nonce && m.pending
            ? { ...m, pending: undefined, failed: true }
            : m,
        ),
      );
    }, SEND_TIMEOUT_MS);
    timersRef.current.set(nonce, timer);
  };

  return {
    messages,
    replaceAll: (history: ChatMessage[]) => setMessages(history),
    /**
     * A `message` broadcast arrived. When `nonce` matches a pending local
     * entry it's our own echo: replace it in place (dedup by nonce, not by
     * id — the local id is a placeholder) instead of appending a duplicate.
     */
    append: (message: ChatMessage, nonce?: string) => {
      if (nonce) {
        clearTimer(nonce);
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.nonce === nonce);
          if (idx === -1) return [...prev, message];
          const next = prev.slice();
          next[idx] = message;
          return next;
        });
        return;
      }
      setMessages((prev) => [...prev, message]);
    },
    /** Replaces the message with the same id in place; unknown ids are ignored. */
    update: (message: ChatMessage) =>
      setMessages((prev) =>
        prev.some((m) => m.id === message.id)
          ? prev.map((m) => (m.id === message.id ? message : m))
          : prev,
      ),
    /** Hard delete: drop the message; unknown ids are ignored. */
    remove: (id: string) =>
      setMessages((prev) => prev.filter((m) => m.id !== id)),
    /** Pagination: prepend older history, skipping ids already loaded. */
    prepend: (older: ChatMessage[]) =>
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const fresh = older.filter((m) => !known.has(m.id));
        return fresh.length === 0 ? prev : [...fresh, ...prev];
      }),
    /** Without a channel, clears everything (server-wide /clear). */
    clearChannel: (channel?: string) =>
      setMessages((prev) =>
        channel ? prev.filter((m) => (m.channel ?? "general") !== channel) : [],
      ),
    /**
     * Optimistic send: appends `draft` as a pending entry (keyed by a fresh
     * nonce, used as its placeholder id) right away, then calls `doSend(nonce)`
     * to put the frame on the wire. Marks the entry failed immediately if
     * `doSend` reports the socket is down, or after SEND_TIMEOUT_MS if no
     * echo (see `append`) shows up. Returns the nonce.
     */
    sendMessage: (draft: MessageDraft, doSend: (nonce: string) => boolean): string => {
      const nonce = crypto.randomUUID();
      const local: LocalMessage = {
        ...draft,
        id: nonce,
        timestamp: Date.now(),
        nonce,
        pending: true,
      };
      setMessages((prev) => [...prev, local]);
      if (!doSend(nonce)) {
        setMessages((prev) =>
          prev.map((m) =>
            m.nonce === nonce ? { ...m, pending: undefined, failed: true } : m,
          ),
        );
        return nonce;
      }
      armTimeout(nonce);
      return nonce;
    },
    /** Re-send a failed message, clearing `failed` and re-arming the timeout. */
    retry: (nonce: string, doSend: (nonce: string) => boolean) => {
      clearTimer(nonce);
      const ok = doSend(nonce);
      setMessages((prev) =>
        prev.map((m) =>
          m.nonce === nonce
            ? { ...m, pending: ok ? true : undefined, failed: ok ? undefined : true }
            : m,
        ),
      );
      if (ok) armTimeout(nonce);
    },
    /** Drop a pending/failed local message the user gave up on. */
    discard: (nonce: string) => {
      clearTimer(nonce);
      setMessages((prev) => prev.filter((m) => m.nonce !== nonce));
    },
  };
}
