import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useToasts } from "./useToasts";

describe("useToasts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("push shows a toast with the given text", () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.push("Could not approve task-1"));

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].text).toBe("Could not approve task-1");
  });

  it("auto-expires a toast after its lifetime, not before", () => {
    const { result } = renderHook(() => useToasts());
    act(() => result.current.push("transient"));

    act(() => vi.advanceTimersByTime(7_999));
    expect(result.current.toasts).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("dismiss removes only the targeted toast", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.push("first");
      result.current.push("second");
    });
    const firstId = result.current.toasts[0].id;

    act(() => result.current.dismiss(firstId));

    expect(result.current.toasts.map((t) => t.text)).toEqual(["second"]);
  });
});
