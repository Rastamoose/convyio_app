import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TypingBroadcast } from "@workspace/shared";
import { useTyping } from "./useTyping";

const typingEvent = (overrides: Partial<TypingBroadcast> = {}): TypingBroadcast => ({
  type: "typing",
  actorId: "a-1",
  name: "Omar",
  channel: "general",
  timestamp: Date.now(),
  ...overrides,
});

describe("useTyping", () => {
  afterEach(() => vi.useRealTimers());

  it("records a typist from a broadcast, keyed per channel", () => {
    const { result } = renderHook(() => useTyping("self-1", () => true));

    act(() => result.current.onTyping(typingEvent()));

    expect(result.current.typistsIn("general").map((t) => t.actorId)).toEqual([
      "a-1",
    ]);
    expect(result.current.typistsIn("random")).toHaveLength(0);
  });

  it("never records self", () => {
    const { result } = renderHook(() => useTyping("self-1", () => true));

    act(() => result.current.onTyping(typingEvent({ actorId: "self-1" })));

    expect(result.current.typistsIn("general")).toHaveLength(0);
  });

  it("expires a typist ~6s after their last signal", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTyping(undefined, () => true));

    act(() => result.current.onTyping(typingEvent()));
    expect(result.current.typistsIn("general")).toHaveLength(1);

    act(() => vi.advanceTimersByTime(7_000));

    expect(result.current.typistsIn("general")).toHaveLength(0);
  });

  it("a fresh signal keeps a typist alive past the original expiry", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTyping(undefined, () => true));

    act(() => result.current.onTyping(typingEvent({ timestamp: Date.now() })));
    act(() => vi.advanceTimersByTime(4_000));
    act(() => result.current.onTyping(typingEvent({ timestamp: Date.now() })));
    act(() => vi.advanceTimersByTime(4_000));

    // 8s since the first signal, but only 4s since the refreshed one.
    expect(result.current.typistsIn("general")).toHaveLength(1);
  });

  it("sendTyping throttles outbound signals to at most once per ~3s", () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const { result } = renderHook(() => useTyping(undefined, send));

    act(() => {
      result.current.sendTyping("general");
      result.current.sendTyping("general");
    });
    expect(send).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(3_100));
    act(() => result.current.sendTyping("general"));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sendTyping throttles independently per channel", () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const { result } = renderHook(() => useTyping(undefined, send));

    act(() => {
      result.current.sendTyping("general");
      result.current.sendTyping("random");
    });

    expect(send).toHaveBeenCalledTimes(2);
  });
});
