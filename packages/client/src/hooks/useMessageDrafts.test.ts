import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMessageDrafts } from "./useMessageDrafts";

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

describe("useMessageDrafts", () => {
  beforeEach(() => vi.stubGlobal("localStorage", storageStub()));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps drafts separate per channel", () => {
    const { result, rerender } = renderHook(
      ({ channel }) => useMessageDrafts("ws-1", channel),
      { initialProps: { channel: "general" } },
    );

    act(() => result.current.setDraft("half-typed thought"));
    rerender({ channel: "random" });
    expect(result.current.draft).toBe("");

    act(() => result.current.setDraft("other thought"));
    rerender({ channel: "general" });
    expect(result.current.draft).toBe("half-typed thought");
  });

  it("persists to localStorage and restores after a remount", () => {
    const first = renderHook(() => useMessageDrafts("ws-1", "general"));
    act(() => first.result.current.setDraft("unsent"));
    first.unmount();

    expect(window.localStorage.getItem("draft:ws-1:general")).toBe("unsent");
    const second = renderHook(() => useMessageDrafts("ws-1", "general"));
    expect(second.result.current.draft).toBe("unsent");
  });

  it("clearDraft empties only that channel's draft and stored entry", () => {
    const { result, rerender } = renderHook(
      ({ channel }) => useMessageDrafts("ws-1", channel),
      { initialProps: { channel: "general" } },
    );
    act(() => result.current.setDraft("send me"));
    rerender({ channel: "random" });
    act(() => result.current.setDraft("keep me"));
    rerender({ channel: "general" });

    act(() => result.current.clearDraft());

    expect(result.current.draft).toBe("");
    expect(window.localStorage.getItem("draft:ws-1:general")).toBeNull();
    expect(window.localStorage.getItem("draft:ws-1:random")).toBe("keep me");
    rerender({ channel: "random" });
    expect(result.current.draft).toBe("keep me");
  });

  it("keeps the same channel separate across workspaces", () => {
    const first = renderHook(() => useMessageDrafts("ws-1", "general"));
    act(() => first.result.current.setDraft("workspace one"));
    first.unmount();

    const second = renderHook(() => useMessageDrafts("ws-2", "general"));
    expect(second.result.current.draft).toBe("");
    act(() => second.result.current.setDraft("workspace two"));

    expect(window.localStorage.getItem("draft:ws-1:general")).toBe("workspace one");
    expect(window.localStorage.getItem("draft:ws-2:general")).toBe("workspace two");
  });
});
