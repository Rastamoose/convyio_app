import { useState } from "react";
import type { ChatMessage } from "@workspace/shared";

/** Chat message log: history replacement on welcome, appends, in-place updates, clears. */
export function useChatMessages() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  return {
    messages,
    replaceAll: (history: ChatMessage[]) => setMessages(history),
    append: (message: ChatMessage) =>
      setMessages((prev) => [...prev, message]),
    /** Replaces the message with the same id in place; unknown ids are ignored. */
    update: (message: ChatMessage) =>
      setMessages((prev) =>
        prev.some((m) => m.id === message.id)
          ? prev.map((m) => (m.id === message.id ? message : m))
          : prev,
      ),
    /** Without a channel, clears everything (server-wide /clear). */
    clearChannel: (channel?: string) =>
      setMessages((prev) =>
        channel ? prev.filter((m) => (m.channel ?? "general") !== channel) : [],
      ),
  };
}
