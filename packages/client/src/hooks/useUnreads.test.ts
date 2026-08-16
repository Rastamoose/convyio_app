import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatMessage } from "@workspace/shared";
import { useUnreads } from "./useUnreads";

const msg = (id: string, channel: string, timestamp: number): ChatMessage => ({
  id,
  authorId: "u-1",
  authorName: "hana",
  authorKind: "human",
  content: id,
  channel,
  timestamp,
});

// node's experimental localStorage global (undefined without a flag) shadows
// jsdom's in this test process, so back it with a real in-memory Storage.
const storageStub = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
};

describe("useUnreads", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", storageStub());
    document.title = "Convyio";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("counts messages newer than the channel's last-read stamp; nothing read yet counts everything", () => {
    const messages = [
      msg("m-1", "general", 1_000),
      msg("m-2", "general", 2_000),
      msg("m-3", "random", 1_500),
    ];
    const { result } = renderHook(() => useUnreads(messages, "ws-1"));

    expect(result.current.unreadCount("general")).toBe(2);
    expect(result.current.unreadCount("random")).toBe(1);
  });

  it("markRead captures the first unread id, then zeroes the channel's count", () => {
    const messages = [
      msg("m-1", "general", 1_000),
      msg("m-2", "general", 2_000),
    ];
    const { result } = renderHook(() => useUnreads(messages, "ws-1"));

    act(() => result.current.markRead("general"));

    expect(result.current.firstUnreadId("general")).toBe("m-1");
    expect(result.current.unreadCount("general")).toBe(0);
  });

  it("the active channel stays at zero even as new messages arrive, but locks in on switching away", () => {
    const messages = [msg("m-1", "general", 1_000)];
    const { result, rerender } = renderHook(
      ({ msgs }) => useUnreads(msgs, "ws-1"),
      { initialProps: { msgs: messages } },
    );

    act(() => result.current.markRead("general"));
    expect(result.current.unreadCount("general")).toBe(0);

    // A new message lands in "general" while it's still the active channel.
    const withNew = [...messages, msg("m-2", "general", 2_000)];
    rerender({ msgs: withNew });
    expect(result.current.unreadCount("general")).toBe(0);

    // Switching to "random" leaves "general" — its read stamp locks in at
    // "now" (well past m-2's timestamp), so it stays read.
    act(() => result.current.markRead("random"));
    expect(result.current.unreadCount("general")).toBe(0);
  });

  it("persists the last-read stamp to localStorage across mounts", () => {
    const messages = [msg("m-1", "general", 1_000)];
    const { result, unmount } = renderHook(() => useUnreads(messages, "ws-1"));

    act(() => result.current.markRead("general"));
    unmount();

    const { result: second } = renderHook(() => useUnreads(messages, "ws-1"));
    // A different channel is active now, so "general" reads via its
    // persisted stamp and stays at zero (m-1 predates it).
    expect(second.current.unreadCount("general")).toBe(0);
  });

  it("prefixes document.title with the total unread count and restores it at zero", () => {
    const messages = [
      msg("m-1", "general", 1_000),
      msg("m-2", "general", 2_000),
      msg("m-3", "random", 1_500),
    ];
    const { result } = renderHook(() => useUnreads(messages, "ws-1"));

    expect(document.title).toBe("(3) Convyio");

    act(() => result.current.markRead("general"));
    expect(document.title).toBe("(1) Convyio");

    act(() => result.current.markRead("random"));
    expect(document.title).toBe("Convyio");
  });

  it("persists unread stamps under workspace-specific keys", () => {
    const messages = [msg("m-1", "general", 1_000)];
    const first = renderHook(() => useUnreads(messages, "ws-1"));
    act(() => first.result.current.markRead("general"));
    first.unmount();

    const second = renderHook(() => useUnreads(messages, "ws-2"));
    expect(second.result.current.unreadCount("general")).toBe(1);
    expect(window.localStorage.getItem("convyio:lastRead:ws-1")).not.toBeNull();
    expect(window.localStorage.getItem("convyio:lastRead:ws-2")).not.toBeNull();
  });
});
