import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppBar } from "./AppBar";

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    workspace: { id: "ws-1", name: "test" },
    demoChannels: [],
    startDemo: vi.fn(),
    participants: [],
    pendingInteractions: [],
    resolveInteraction: vi.fn(),
    pendingResourceAccessRequests: [],
    resolveResourceAccessRequest: vi.fn(),
    pendingProjectAccessRequests: [],
    resolveProjectAccessRequest: vi.fn(),
  }),
}));

function renderAppBar() {
  const handlers = {
    onSetView: vi.fn(),
  };
  render(
    <AppBar view="chat" channel="general" {...handlers} />,
  );
  return handlers;
}

describe("AppBar", () => {
  it("uses the yellow brand mark", () => {
    renderAppBar();
    expect(screen.getByAltText("convyio")).toHaveAttribute("src", "/mark-yellow.svg");
  });

  it("switches the workspace view from the tabs", async () => {
    const user = userEvent.setup();
    const { onSetView } = renderAppBar();

    await user.click(screen.getByRole("tab", { name: "Board" }));
    expect(onSetView).toHaveBeenCalledWith("board");
  });
});
