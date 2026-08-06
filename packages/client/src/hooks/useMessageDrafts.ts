import { useCallback, useState } from "react";

const storageKey = (channel: string) => `draft:${channel}`;

/**
 * Per-channel composer drafts. Each channel keeps its own draft (switching
 * channels never leaks text), persisted to localStorage so drafts survive
 * reloads and reconnects. Sending/clearing removes the stored entry.
 */
export function useMessageDrafts(channel: string): {
  draft: string;
  setDraft: (value: string) => void;
  clearDraft: () => void;
} {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const setDraft = useCallback(
    (value: string) => {
      setDrafts((prev) => ({ ...prev, [channel]: value }));
      if (value) window.localStorage.setItem(storageKey(channel), value);
      else window.localStorage.removeItem(storageKey(channel));
    },
    [channel],
  );

  return {
    draft:
      drafts[channel] ?? window.localStorage.getItem(storageKey(channel)) ?? "",
    setDraft,
    clearDraft: useCallback(() => setDraft(""), [setDraft]),
  };
}
