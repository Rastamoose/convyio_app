import type { ItemStatus, Participant } from "@workspace/shared";

/**
 * Status → label/color mappings — the single source so the board, drawer and
 * sidebar always color a status the same way.
 */

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  proposed: "Proposed",
  approved: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  denied: "Denied",
};

/** Tailwind text classes for an item status badge. */
export const ITEM_STATUS_BADGE: Record<ItemStatus, string> = {
  proposed: "text-dead",
  approved: "text-working",
  in_progress: "text-online",
  blocked: "text-away",
  done: "text-muted",
  denied: "text-faint line-through",
};

/**
 * Presence dot for a participant: Tailwind bg class plus whether it pulses.
 * Agent semantics (see AGENTS.md): green=working, orange=idle, red=blocked or
 * dead, grey=offline. Humans are simply online/offline.
 */
export function presenceDot(participant: Participant): {
  color: string;
  pulse: boolean;
} {
  if (participant.kind === "agent") {
    if (participant.runState === "working") return { color: "bg-online", pulse: true };
    if (participant.runState === "blocked") return { color: "bg-dead", pulse: true };
    if (participant.runState === "dead") return { color: "bg-dead", pulse: false };
    return { color: participant.online ? "bg-away" : "bg-offline", pulse: false };
  }
  return { color: participant.online ? "bg-online" : "bg-offline", pulse: false };
}
