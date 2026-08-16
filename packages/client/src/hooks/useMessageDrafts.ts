import { useCallback, useState } from "react";

export const messageDraftStorageKey = (workspaceId: string, channel: string) =>
  `draft:${workspaceId}:${channel}`;

/**
 * Per-channel composer drafts. Each channel keeps its own draft (switching
 * channels never leaks text), persisted to localStorage so drafts survive
 * reloads and reconnects. Sending/clearing removes the stored entry.
 */
export function useMessageDrafts(workspaceId: string, channel: string): {
  draft: string;
  setDraft: (value: string) => void;
  clearDraft: () => void;
} {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = messageDraftStorageKey(workspaceId, channel);

  const setDraft = useCallback(
    (value: string) => {
      setDrafts((prev) => ({ ...prev, [key]: value }));
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    },
    [key],
  );

  return {
    draft: drafts[key] ?? window.localStorage.getItem(key) ?? "",
    setDraft,
    clearDraft: useCallback(() => setDraft(""), [setDraft]),
  };
}
