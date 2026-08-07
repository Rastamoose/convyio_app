import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useToasts } from "./useToasts";

// Auto-expiry (and its hover pause) lives in the Toasts component, not here.
describe("useToasts", () => {
  it("push shows a toast with the given text, defaulting to an error", () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.push("Could not approve task-1"));

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].text).toBe("Could not approve task-1");
    expect(result.current.toasts[0].kind).toBe("error");
  });

  it("push records an explicit kind", () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.push("Task marked done", "success");
      result.current.push("Agent reconnected", "info");
    });

    expect(result.current.toasts.map((t) => t.kind)).toEqual([
      "success",
      "info",
    ]);
  });

  it("push records an optional action", () => {
    const { result } = renderHook(() => useToasts());

    act(() =>
      result.current.push("agent proposed: fix the header", "info", {
        label: "View",
        itemId: "item-1",
      }),
    );

    expect(result.current.toasts[0].action).toEqual({
      label: "View",
      itemId: "item-1",
    });
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
