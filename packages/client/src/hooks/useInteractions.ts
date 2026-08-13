import { useState } from "react";
import type { InteractionRequest } from "@workspace/shared";

/**
 * Permission prompts a run is paused on. The server owns the record; this only
 * mirrors which ones are still pending so every surface — the inline capsule,
 * the approval queue — renders the same request id rather than its own copy.
 */
export function useInteractions() {
  const [pending, setPending] = useState<InteractionRequest[]>([]);

  return {
    pending,
    reset: () => setPending([]),
    open: (request: InteractionRequest) =>
      setPending((prev) =>
        prev.some((r) => r.id === request.id) ? prev : [...prev, request],
      ),
    close: (requestId: string) =>
      setPending((prev) => prev.filter((r) => r.id !== requestId)),
  };
}
