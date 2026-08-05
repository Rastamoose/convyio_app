import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage } from "@workspace/shared";
import { PinnedMessages } from "./PinnedMessages";

// The bar reads pinMessage from the workspace context; the bar is the unit
// under test, so only that collaborator is replaced.
const pinMessage = vi.fn();
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({ pinMessage }),
}));

const message = (
  id: string,
  content: string,
  pin?: { at: number; by: string },
): ChatMessage => ({
  id,
  authorId: "u-1",
  authorName: "hana",
  authorKind: "human",
  content,
  timestamp: 1_000,
  ...(pin ? { pinnedAt: pin.at, pinnedBy: pin.by } : {}),
});

describe("PinnedMessages", () => {
  const onJump = vi.fn();
  beforeEach(() => vi.clearAllMocks());

  it("renders nothing when no message is pinned", () => {
    const { container } = render(
      <PinnedMessages
        messages={[message("m-1", "plain"), message("m-2", "also plain")]}
        onJump={onJump}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the pinned count for messages with pinnedAt", () => {
    render(
      <PinnedMessages
        messages={[
          message("m-1", "plain"),
          message("m-2", "first pin", { at: 10, by: "omar" }),
          message("m-3", "second pin", { at: 20, by: "hana" }),
        ]}
        onJump={onJump}
      />,
    );

    expect(
      screen.getByRole("button", { name: "2 pinned" }),
    ).toBeInTheDocument();
  });

  it("opens a panel listing pins newest first, attachment-only ones by count", async () => {
    const user = userEvent.setup();
    render(
      <PinnedMessages
        messages={[
          {
            ...message("m-1", "", { at: 30, by: "omar" }),
            attachments: [
              {
                id: "up-1",
                name: "cat.png",
                mime: "image/png",
                size: 2048,
                url: "/api/uploads/up-1/cat.png",
              },
            ],
          },
          message("m-2", "older pin", { at: 10, by: "hana" }),
        ]}
        onJump={onJump}
      />,
    );

    await user.click(screen.getByRole("button", { name: "2 pinned" }));

    const pinnedBy = screen
      .getAllByText(/^Pinned by /)
      .map((el) => el.textContent);
    expect(pinnedBy).toEqual(["Pinned by omar", "Pinned by hana"]);
    expect(screen.getByText("1 attachment(s)")).toBeInTheDocument();
    expect(screen.getByText("older pin")).toBeInTheDocument();
  });

  it("clicking an entry's unpin calls the context action", async () => {
    const user = userEvent.setup();
    render(
      <PinnedMessages
        messages={[message("m-1", "pinned", { at: 10, by: "omar" })]}
        onJump={onJump}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1 pinned" }));
    await user.click(screen.getByRole("button", { name: "Unpin message" }));

    expect(pinMessage).toHaveBeenCalledWith("m-1", false);
  });

  it("clicking an entry jumps to the message and closes the panel", async () => {
    const user = userEvent.setup();
    render(
      <PinnedMessages
        messages={[message("m-1", "pinned", { at: 10, by: "omar" })]}
        onJump={onJump}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1 pinned" }));
    await user.click(screen.getByText("pinned"));

    expect(onJump).toHaveBeenCalledWith("m-1");
    expect(screen.queryByText("Pinned by omar")).not.toBeInTheDocument();
  });

  it("Escape closes the panel", async () => {
    const user = userEvent.setup();
    render(
      <PinnedMessages
        messages={[message("m-1", "pinned", { at: 10, by: "omar" })]}
        onJump={onJump}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1 pinned" }));
    expect(screen.getByText("Pinned by omar")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText("Pinned by omar")).not.toBeInTheDocument();
  });
});
