import { useState } from "react";
import type { ChatMessage } from "@workspace/shared";

/** Chat message log: history replacement on welcome, appends, clears. */
export function useChatMessages() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  return {
    messages,
    replaceAll: (history: ChatMessage[]) => setMessages(history),
    append: (message: ChatMessage) =>
      setMessages((prev) => [...prev, message]),
    /** Without a channel, clears everything (server-wide /clear). */
    clearChannel: (channel?: string) =>
      setMessages((prev) =>
        channel ? prev.filter((m) => (m.channel ?? "general") !== channel) : [],
      ),
  };
}
