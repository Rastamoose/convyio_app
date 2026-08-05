import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatMessage } from "@workspace/shared";
import { useChatMessages } from "./useChatMessages";

const message = (id: string, content: string): ChatMessage => ({
  id,
  authorId: "u-1",
  authorName: "hana",
  authorKind: "human",
  content,
  timestamp: 1_000,
});

describe("useChatMessages", () => {
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
});
