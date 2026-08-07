import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatMessage } from "@workspace/shared";
import { useChatMessages, type MessageDraft } from "./useChatMessages";

const message = (id: string, content: string): ChatMessage => ({
  id,
  authorId: "u-1",
  authorName: "hana",
  authorKind: "human",
  content,
  timestamp: 1_000,
});

const draft = (content: string): MessageDraft => ({
  authorId: "u-1",
  authorName: "hana",
  authorKind: "human",
  content,
});

describe("useChatMessages", () => {
  afterEach(() => vi.useRealTimers());

  it("update replaces the matching message in place", () => {
    const { result } = renderHook(() => useChatMessages());
    act(() =>
      result.current.replaceAll([message("m-1", "one"), message("m-2", "two")]),
    );

    act(() =>
      result.current.update({
        ...message("m-2", "two"),
        pinnedAt: 5_000,
        pinnedBy: "omar",
      }),
    );

    expect(result.current.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(result.current.messages[1].pinnedAt).toBe(5_000);
    expect(result.current.messages[1].pinnedBy).toBe("omar");
    expect(result.current.messages[0]).toEqual(message("m-1", "one"));
  });

  it("update with an unknown id changes nothing", () => {
    const { result } = renderHook(() => useChatMessages());
    act(() => result.current.replaceAll([message("m-1", "one")]));
    const before = result.current.messages;

    act(() => result.current.update(message("m-404", "ghost")));

    expect(result.current.messages).toBe(before);
  });

  it("remove drops the message with the given id", () => {
    const { result } = renderHook(() => useChatMessages());
    act(() =>
      result.current.replaceAll([message("m-1", "one"), message("m-2", "two")]),
    );

    act(() => result.current.remove("m-1"));

    expect(result.current.messages.map((m) => m.id)).toEqual(["m-2"]);
  });

  it("prepend adds older history without duplicating ids already present", () => {
    const { result } = renderHook(() => useChatMessages());
    act(() => result.current.replaceAll([message("m-2", "two")]));

    act(() =>
      result.current.prepend([message("m-1", "one"), message("m-2", "stale")]),
    );

    expect(result.current.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    // The already-loaded copy wins; prepend doesn't overwrite it.
    expect(result.current.messages[1].content).toBe("two");
  });

  it("sendMessage appends a pending entry, and the matching echo replaces it in place by nonce", () => {
    const { result } = renderHook(() => useChatMessages());

    let nonce = "";
    act(() => {
      nonce = result.current.sendMessage(draft("hello"), () => true);
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      content: "hello",
      pending: true,
    });

    act(() =>
      result.current.append({ ...message("m-1", "hello"), timestamp: 2_000 }, nonce),
    );

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toEqual({
      ...message("m-1", "hello"),
      timestamp: 2_000,
    });
  });

  it("marks the message failed immediately when the socket is down", () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.sendMessage(draft("hi"), () => false);
    });

    expect(result.current.messages[0].failed).toBe(true);
    expect(result.current.messages[0].pending).toBeUndefined();
  });

  it("marks the message failed after 10s with no echo", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.sendMessage(draft("hi"), () => true);
    });
    expect(result.current.messages[0].pending).toBe(true);

    act(() => vi.advanceTimersByTime(10_000));

    expect(result.current.messages[0].failed).toBe(true);
    expect(result.current.messages[0].pending).toBeUndefined();
  });

  it("does not mark failed if the echo arrives before the timeout", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatMessages());

    let nonce = "";
    act(() => {
      nonce = result.current.sendMessage(draft("hi"), () => true);
    });
    act(() => vi.advanceTimersByTime(5_000));
    act(() => result.current.append(message("m-1", "hi"), nonce));
    act(() => vi.advanceTimersByTime(10_000));

    expect(result.current.messages[0].failed).toBeUndefined();
  });

  it("retry clears failed and re-arms the timeout", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatMessages());

    let nonce = "";
    act(() => {
      nonce = result.current.sendMessage(draft("hi"), () => false);
    });
    expect(result.current.messages[0].failed).toBe(true);

    act(() => result.current.retry(nonce, () => true));
    expect(result.current.messages[0].failed).toBeUndefined();
    expect(result.current.messages[0].pending).toBe(true);

    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.messages[0].failed).toBe(true);
  });

  it("discard removes a pending/failed local message", () => {
    const { result } = renderHook(() => useChatMessages());

    let nonce = "";
    act(() => {
      nonce = result.current.sendMessage(draft("hi"), () => false);
    });

    act(() => result.current.discard(nonce));

    expect(result.current.messages).toHaveLength(0);
  });
});
