import type { ChatMessage } from "@workspace/shared";

/**
 * Persistence boundary. The hub only ever talks to this interface, so the
 * JSON-file implementation can be swapped for a database without touching
 * anything upstream.
 */
export interface Storage {
  loadMessages(): Promise<ChatMessage[]>;
  appendMessage(message: ChatMessage): Promise<void>;
  /** Clear all messages, or only those in the given channel. */
  clearMessages(channel?: string): Promise<void>;
}
